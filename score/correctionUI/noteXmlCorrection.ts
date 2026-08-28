// Patches individual <note> elements' pitch and/or duration directly in the raw MusicXML
// string, since score/renderer parses that XML itself rather than going through ScoreDocument
// (see renderer/index.ts's header comment) -- applying a correction only to the ScoreDocument
// model via this directory's index.ts (applyCorrection) wouldn't change what's actually
// rendered. Mirrors renderer/timeSignatureCorrection.ts's pattern: parse, mutate the DOM,
// reserialize.
//
// Notes are addressed by (measureIndex, noteIndexInMeasure) rather than ScoreNote.id -- that id
// is a fresh crypto.randomUUID() on every import with no counterpart in the XML to look up.
// noteIndexInMeasure walks the exact same primary-voice/grace-note/rest filtering
// musicxmlImport.ts uses when building ScoreDocument.measures[i].notes (including chord notes,
// each of which gets its own index there), so index j here always addresses the same logical
// note as ScoreDocument.measures[measureIndex].notes[j].

export interface NoteXmlCorrection {
  measureIndex: number;
  noteIndexInMeasure: number;
  // "<Step><#|b|><Octave>", e.g. "C#4" -- matches musicxmlImport.ts's pitchToNoteName format.
  // Omit to leave pitch unchanged.
  pitch?: string;
  // Quarter-note units, matching ScoreNote.durationBeats. Omit to leave duration unchanged.
  durationBeats?: number;
}

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

function parsePitchString(pitch: string): { step: string; alter: number; octave: string } | null {
  const match = /^([A-G])(#|b)?(\d{1,2})$/.exec(pitch.trim());
  if (!match) {
    return null;
  }
  const [, step, accidental, octave] = match;
  return { step, alter: accidental === "#" ? 1 : accidental === "b" ? -1 : 0, octave };
}

function writePitch(pitchElement: Element, pitch: string): void {
  const parsed = parsePitchString(pitch);
  if (!parsed) {
    return;
  }

  const stepElement = directChild(pitchElement, "step");
  const octaveElement = directChild(pitchElement, "octave");
  if (!stepElement || !octaveElement) {
    return;
  }
  stepElement.textContent = parsed.step;
  octaveElement.textContent = parsed.octave;

  const existingAlter = directChild(pitchElement, "alter");
  if (parsed.alter === 0) {
    existingAlter?.remove();
    return;
  }

  if (existingAlter) {
    existingAlter.textContent = String(parsed.alter);
  } else {
    const alterElement = pitchElement.ownerDocument.createElement("alter");
    alterElement.textContent = String(parsed.alter);
    stepElement.after(alterElement);
  }
}

// Standard binary note-value durations (quarter-note units) this UI can express visually via
// <type>/<dot> -- covers the "fix it in under a minute, not a full notation editor" scope this
// feature is meant for (see the plan doc's §4b). A duration correction that doesn't land on one
// of these (within floating-point tolerance) still updates <duration> below, so beat-math like
// time-signature inference improves, but leaves the visual glyph as whatever it already was.
const NOTE_TYPE_BY_QUARTER_NOTES: Array<{ quarterNotes: number; type: string; dots: number }> = [
  { quarterNotes: 4, type: "whole", dots: 0 },
  { quarterNotes: 3, type: "half", dots: 1 },
  { quarterNotes: 2, type: "half", dots: 0 },
  { quarterNotes: 1.5, type: "quarter", dots: 1 },
  { quarterNotes: 1, type: "quarter", dots: 0 },
  { quarterNotes: 0.75, type: "eighth", dots: 1 },
  { quarterNotes: 0.5, type: "eighth", dots: 0 },
  { quarterNotes: 0.375, type: "16th", dots: 1 },
  { quarterNotes: 0.25, type: "16th", dots: 0 },
  { quarterNotes: 0.125, type: "32nd", dots: 0 },
  { quarterNotes: 0.0625, type: "64th", dots: 0 }
];

function writeNoteType(noteElement: Element, durationBeats: number): void {
  const resolved = NOTE_TYPE_BY_QUARTER_NOTES.find((entry) => Math.abs(entry.quarterNotes - durationBeats) < 0.001);
  if (!resolved) {
    return;
  }
  const doc = noteElement.ownerDocument;

  let typeElement = directChild(noteElement, "type");
  if (!typeElement) {
    typeElement = doc.createElement("type");
    const durationElement = directChild(noteElement, "duration");
    if (durationElement) {
      durationElement.after(typeElement);
    } else {
      noteElement.appendChild(typeElement);
    }
  }
  typeElement.textContent = resolved.type;

  for (const dot of directChildren(noteElement, "dot")) {
    dot.remove();
  }
  let insertAfter: Element = typeElement;
  for (let i = 0; i < resolved.dots; i += 1) {
    const dotElement = doc.createElement("dot");
    insertAfter.after(dotElement);
    insertAfter = dotElement;
  }
}

function writeDuration(noteElement: Element, durationBeats: number, divisions: number): void {
  const durationElement = directChild(noteElement, "duration");
  if (durationElement) {
    durationElement.textContent = String(Math.round(durationBeats * divisions));
  }
  writeNoteType(noteElement, durationBeats);
}

export function applyNoteCorrectionsToXml(xml: string, corrections: NoteXmlCorrection[]): string {
  if (corrections.length === 0) {
    return xml;
  }

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    return xml;
  }

  const part = doc.querySelector("part");
  if (!part) {
    return xml;
  }

  const byMeasure = new Map<number, Map<number, NoteXmlCorrection>>();
  for (const correction of corrections) {
    let byIndex = byMeasure.get(correction.measureIndex);
    if (!byIndex) {
      byIndex = new Map();
      byMeasure.set(correction.measureIndex, byIndex);
    }
    byIndex.set(correction.noteIndexInMeasure, correction);
  }

  // divisions is sticky/carry-forward across measures like time signatures are (see
  // renderer/timeSignatureCorrection.ts's own comment on the same MusicXML quirk), so this walks
  // every measure in order -- not just the ones with corrections -- to keep the running value
  // correct for whichever measure a correction actually lands on.
  let divisions = 1;

  Array.from(part.querySelectorAll("measure")).forEach((measureElement, measureIndex) => {
    for (const attributes of directChildren(measureElement, "attributes")) {
      const divisionsText = directChild(attributes, "divisions")?.textContent;
      if (divisionsText) {
        divisions = Number.parseInt(divisionsText, 10) || divisions;
      }
    }

    const measureCorrections = byMeasure.get(measureIndex);
    if (!measureCorrections) {
      return;
    }

    let primaryVoice: string | null = null;
    let noteIndex = 0;

    for (const child of Array.from(measureElement.children)) {
      if (child.tagName !== "note") {
        continue;
      }
      if (directChild(child, "grace") !== null) {
        continue;
      }

      const voiceText = directChild(child, "voice")?.textContent ?? null;
      if (primaryVoice === null && voiceText !== null) {
        primaryVoice = voiceText;
      }
      if (voiceText !== null && voiceText !== primaryVoice) {
        continue;
      }

      const isRest = directChild(child, "rest") !== null;
      const pitchElement = directChild(child, "pitch");
      if (isRest || !pitchElement) {
        continue;
      }

      const correction = measureCorrections.get(noteIndex);
      noteIndex += 1;
      if (!correction) {
        continue;
      }

      if (correction.pitch) {
        writePitch(pitchElement, correction.pitch);
      }
      if (correction.durationBeats !== undefined && correction.durationBeats > 0) {
        writeDuration(child, correction.durationBeats, divisions);
      }
    }
  });

  return new XMLSerializer().serializeToString(doc);
}
