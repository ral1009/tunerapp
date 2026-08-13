// Computes beat-aware beam groups ourselves and injects them into the MusicXML before OSMD
// parses it, instead of relying on OSMD's own automatic beaming.
//
// Why this exists: OSMD's `autoBeam` option only fills gaps for notes with zero <beam> data,
// and HOMR-sourced XML typically has none at all, so autoBeam *should* apply — but direct
// testing (hand-built fixtures rendered through the real app) found OSMD's own default beat-
// grouping fails outright on a repeating pitch pattern (confirmed: a repeating 3-note phrase
// in 12/8 renders completely unbeamed, while an otherwise-identical varied-pitch phrase beams
// correctly). "Send in the Clowns"' opening motif is exactly a repeating 3-note phrase, which
// is why it reliably breaks. OSMD's automatic grouping can't be trusted, so we compute and
// write the <beam> elements ourselves from each measure's actual time signature.
//
// Scope boundaries (intentional, not oversights): grace notes are excluded from grouping and
// left to OSMD's default handling; <time-modification> (tuplets) isn't accounted for in beat
// math, matching this renderer's pre-existing "no tuplet notation" limitation; multi-voice
// measures never group across a <voice> change, though this isn't deeply exercised since every
// real note observed in actual HOMR output so far has been <voice>1</voice>.

const BEAM_LEVEL_BY_TYPE: Record<string, number> = {
  eighth: 1,
  "16th": 2,
  "32nd": 3,
  "64th": 4,
  "128th": 5,
  "256th": 6
};

function directChild(element: Element, tagName: string): Element | null {
  for (const child of Array.from(element.children)) {
    if (child.tagName === tagName) {
      return child;
    }
  }
  return null;
}

function directChildren(element: Element, tagName: string): Element[] {
  return Array.from(element.children).filter((child) => child.tagName === tagName);
}

// One "column" is a primary note plus any <chord/> continuations at the same tick position —
// they share a beam-group decision and each get identical <beam> elements.
interface Column {
  elements: Element[];
  startTick: number;
  beamLevel: number;
  voice: string | null;
}

function computeBeatTicks(divisions: number, beats: number, beatType: number): number {
  // Compound meter (6/8, 9/8, 12/8, ...): one beat is a dotted quarter = 3 eighths.
  // 3/8 is excluded on purpose — conventionally treated as simple triple with an eighth beat.
  if (beatType === 8 && beats % 3 === 0 && beats > 3) {
    return divisions * 1.5;
  }
  // Simple meter: one beat is the note value the beat-type denominator names.
  return (divisions * 4) / beatType;
}

function buildColumns(measure: Element): Column[] {
  const columns: Column[] = [];
  let position = 0;
  let pending: Column | null = null;

  const flushPending = (): void => {
    if (pending) {
      columns.push(pending);
    }
    pending = null;
  };

  for (const child of Array.from(measure.children)) {
    if (child.tagName === "backup" || child.tagName === "forward") {
      flushPending();
      const durationText = directChild(child, "duration")?.textContent;
      const delta = durationText ? Number.parseInt(durationText, 10) : 0;
      position += child.tagName === "forward" ? delta : -delta;
      continue;
    }

    if (child.tagName !== "note") {
      continue;
    }

    if (directChild(child, "grace") !== null) {
      continue;
    }

    const isChord = directChild(child, "chord") !== null;
    const isRest = directChild(child, "rest") !== null;
    const durationText = directChild(child, "duration")?.textContent;
    const durationTicks = durationText ? Number.parseInt(durationText, 10) : 0;
    const typeText = directChild(child, "type")?.textContent ?? "";
    const beamLevel = isRest ? 0 : (BEAM_LEVEL_BY_TYPE[typeText] ?? 0);
    const voiceText = directChild(child, "voice")?.textContent ?? null;

    if (isChord && pending) {
      pending.elements.push(child);
    } else {
      flushPending();
      pending = { elements: [child], startTick: position, beamLevel, voice: voiceText };
    }

    if (!isChord) {
      position += durationTicks;
    }
  }

  flushPending();
  return columns;
}

function groupColumns(columns: Column[], beatTicks: number): Column[][] {
  const groups: Column[][] = [];
  let current: Column[] = [];

  const flushGroup = (): void => {
    if (current.length >= 2) {
      groups.push(current);
    }
    current = [];
  };

  for (const column of columns) {
    const isBeamable = column.beamLevel > 0;
    const last = current[current.length - 1];
    const sameContext =
      last !== undefined &&
      Math.floor(column.startTick / beatTicks) === Math.floor(last.startTick / beatTicks) &&
      column.voice === last.voice;

    if (isBeamable && (current.length === 0 || sameContext)) {
      current.push(column);
    } else {
      flushGroup();
      if (isBeamable) {
        current.push(column);
      }
    }
  }

  flushGroup();
  return groups;
}

// Standard MusicXML multi-level beam encoding: at each level a note is begin/continue/end
// if it has a beamed neighbor on that side, or a forward/backward hook if it's the only note
// requiring that level within its run (e.g. a lone 16th next to a dotted eighth).
function applyBeamElementsToGroup(group: Column[]): void {
  const maxLevel = Math.max(...group.map((column) => column.beamLevel));

  for (let level = 1; level <= maxLevel; level += 1) {
    const participates = group.map((column) => column.beamLevel >= level);

    for (let i = 0; i < group.length; i += 1) {
      if (!participates[i]) {
        continue;
      }

      const prev = i > 0 && participates[i - 1];
      const next = i < group.length - 1 && participates[i + 1];

      let beamType: string;
      if (prev && next) {
        beamType = "continue";
      } else if (!prev && next) {
        beamType = "begin";
      } else if (prev && !next) {
        beamType = "end";
      } else {
        beamType = i < group.length - 1 ? "forward hook" : "backward hook";
      }

      for (const element of group[i].elements) {
        const doc = element.ownerDocument;
        const beamElement = doc.createElement("beam");
        beamElement.setAttribute("number", String(level));
        beamElement.textContent = beamType;

        const notationsElement = directChild(element, "notations");
        if (notationsElement) {
          element.insertBefore(beamElement, notationsElement);
        } else {
          element.appendChild(beamElement);
        }
      }
    }
  }
}

export function applyAutomaticBeaming(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    return xml;
  }

  const part = doc.querySelector("part");
  if (!part) {
    return xml;
  }

  // Replace whatever beam data the source had (if any) with our own computation.
  for (const beamElement of Array.from(doc.querySelectorAll("note > beam"))) {
    beamElement.remove();
  }

  let divisions = 1;
  let beats = 4;
  let beatType = 4;

  for (const measure of Array.from(part.querySelectorAll("measure"))) {
    for (const attributes of directChildren(measure, "attributes")) {
      const divisionsText = directChild(attributes, "divisions")?.textContent;
      if (divisionsText) {
        divisions = Number.parseInt(divisionsText, 10) || divisions;
      }

      const timeElement = directChild(attributes, "time");
      const beatsText = timeElement ? directChild(timeElement, "beats")?.textContent : null;
      const beatTypeText = timeElement ? directChild(timeElement, "beat-type")?.textContent : null;
      if (beatsText && beatTypeText) {
        beats = Number.parseInt(beatsText, 10) || beats;
        beatType = Number.parseInt(beatTypeText, 10) || beatType;
      }
    }

    const beatTicks = computeBeatTicks(divisions, beats, beatType);
    const columns = buildColumns(measure);
    const groups = groupColumns(columns, beatTicks);
    for (const group of groups) {
      applyBeamElementsToGroup(group);
    }
  }

  return new XMLSerializer().serializeToString(doc);
}
