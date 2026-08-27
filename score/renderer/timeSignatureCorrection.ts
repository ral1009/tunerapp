// Auto-corrects a measure's <time> signature when its actual note/rest duration doesn't match
// the currently active time signature -- typically HOMR failing to detect a mid-piece meter
// change and carrying the previous one forward. Mirrors the equivalent correction applied to the
// internal ScoreDocument model in score/musicxmlImport.ts (same shared score/timeSignatureInference.ts
// heuristic), applied here directly to the raw XML instead, since the renderer parses that XML
// itself rather than going through ScoreDocument (see renderer/index.ts's header comment) --
// correcting only one side would leave the rendered notation and the ScoreDocument metadata
// disagreeing about a measure's meter.
import { inferTimeSignature } from "../timeSignatureInference";

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

function measureQuarterNoteTotal(measure: Element, divisions: number): number {
  let positionTicks = 0;

  for (const child of Array.from(measure.children)) {
    if (child.tagName === "backup" || child.tagName === "forward") {
      const durationText = directChild(child, "duration")?.textContent;
      const delta = durationText ? Number.parseInt(durationText, 10) : 0;
      positionTicks += child.tagName === "forward" ? delta : -delta;
      continue;
    }

    if (child.tagName !== "note") {
      continue;
    }
    if (directChild(child, "grace") !== null || directChild(child, "chord") !== null) {
      continue;
    }

    const durationText = directChild(child, "duration")?.textContent;
    positionTicks += durationText ? Number.parseInt(durationText, 10) : 0;
  }

  return divisions > 0 ? positionTicks / divisions : 0;
}

// Writes/replaces <time> inside the measure's <attributes> (creating either as needed),
// following MusicXML's expected <attributes> child order (divisions, key, time, ...).
function writeTimeSignature(measure: Element, beats: number, beatType: number): void {
  const doc = measure.ownerDocument;
  let attributes = directChild(measure, "attributes");
  if (!attributes) {
    attributes = doc.createElement("attributes");
    measure.insertBefore(attributes, measure.firstChild);
  }

  let timeElement = directChild(attributes, "time");
  if (!timeElement) {
    timeElement = doc.createElement("time");
    const divisionsEl = directChild(attributes, "divisions");
    const keyEl = directChild(attributes, "key");
    const insertBefore = keyEl?.nextSibling ?? divisionsEl?.nextSibling ?? attributes.firstChild;
    attributes.insertBefore(timeElement, insertBefore);
  } else {
    while (timeElement.firstChild) {
      timeElement.removeChild(timeElement.firstChild);
    }
  }

  const beatsElement = doc.createElement("beats");
  beatsElement.textContent = String(beats);
  const beatTypeElement = doc.createElement("beat-type");
  beatTypeElement.textContent = String(beatType);
  timeElement.appendChild(beatsElement);
  timeElement.appendChild(beatTypeElement);
}

export function applyTimeSignatureCorrection(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    return xml;
  }

  const part = doc.querySelector("part");
  if (!part) {
    return xml;
  }

  let divisions = 1;
  // "genuine" is what the source XML actually declares (only ever updated by a real
  // <attributes><time> in the document) -- mismatches are always measured against this, so a
  // string of several consecutive miss-tagged measures each still get their own independent
  // correction rather than only the first. "effective" is what OSMD will actually be using at
  // this point given every <time> written into the document so far, including our own
  // corrections -- MusicXML time signatures are sticky/carry-forward, so once a correction
  // writes an explicit <time>, every later measure with no declaration of its own inherits THAT
  // until something else overrides it. Tracked separately so a bar whose own duration fits the
  // genuine meter again, right after an anomalous one, gets an explicit reverting <time> instead
  // of silently staying in the corrected meter forever.
  let genuineBeats = 4;
  let genuineBeatType = 4;
  let effectiveBeats = 4;
  let effectiveBeatType = 4;

  for (const measure of Array.from(part.querySelectorAll("measure"))) {
    let hasOwnDeclaration = false;

    for (const attributes of directChildren(measure, "attributes")) {
      const divisionsText = directChild(attributes, "divisions")?.textContent;
      if (divisionsText) {
        divisions = Number.parseInt(divisionsText, 10) || divisions;
      }

      const timeElement = directChild(attributes, "time");
      const beatsText = timeElement ? directChild(timeElement, "beats")?.textContent : null;
      const beatTypeText = timeElement ? directChild(timeElement, "beat-type")?.textContent : null;
      if (beatsText && beatTypeText) {
        genuineBeats = Number.parseInt(beatsText, 10) || genuineBeats;
        genuineBeatType = Number.parseInt(beatTypeText, 10) || genuineBeatType;
        hasOwnDeclaration = true;
      }
    }

    if (hasOwnDeclaration) {
      // A real declaration in the source always resets what OSMD renders from here, regardless
      // of what an earlier correction left behind.
      effectiveBeats = genuineBeats;
      effectiveBeatType = genuineBeatType;
    }

    const actualQuarterNotes = measureQuarterNoteTotal(measure, divisions);
    const expectedQuarterNotes = (genuineBeats * 4) / genuineBeatType;

    if (Math.abs(actualQuarterNotes - expectedQuarterNotes) > 0.01) {
      const inferred = inferTimeSignature(actualQuarterNotes, genuineBeatType);
      if (inferred) {
        writeTimeSignature(measure, inferred.beats, inferred.beatType);
        effectiveBeats = inferred.beats;
        effectiveBeatType = inferred.beatType;
      }
    } else if (!hasOwnDeclaration && (effectiveBeats !== genuineBeats || effectiveBeatType !== genuineBeatType)) {
      // This bar fits the genuine meter again, but the last explicit <time> in the document is
      // still a previous bar's correction -- write it back explicitly or every following bar
      // renders in the corrected meter until the source happens to declare one of its own.
      writeTimeSignature(measure, genuineBeats, genuineBeatType);
      effectiveBeats = genuineBeats;
      effectiveBeatType = genuineBeatType;
    }
  }

  return new XMLSerializer().serializeToString(doc);
}
