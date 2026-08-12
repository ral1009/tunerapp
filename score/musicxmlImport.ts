import type { ScoreDocument, ScoreMeasure, ScoreNote } from "./schema";

const MAJOR_KEY_BY_FIFTHS: Record<number, string> = {
  [-7]: "Cb",
  [-6]: "Gb",
  [-5]: "Db",
  [-4]: "Ab",
  [-3]: "Eb",
  [-2]: "Bb",
  [-1]: "F",
  0: "C",
  1: "G",
  2: "D",
  3: "A",
  4: "E",
  5: "B",
  6: "F#",
  7: "C#"
};

const MINOR_KEY_BY_FIFTHS: Record<number, string> = {
  [-7]: "Abm",
  [-6]: "Ebm",
  [-5]: "Bbm",
  [-4]: "Fm",
  [-3]: "Cm",
  [-2]: "Gm",
  [-1]: "Dm",
  0: "Am",
  1: "Em",
  2: "Bm",
  3: "F#m",
  4: "C#m",
  5: "G#m",
  6: "D#m",
  7: "A#m"
};

function pitchToNoteName(step: string, alter: number, octave: string): string {
  const accidental = alter > 0 ? "#" : alter < 0 ? "b" : "";
  return `${step}${accidental}${octave}`;
}

function directChild(element: Element, tagName: string): Element | null {
  for (const child of Array.from(element.children)) {
    if (child.tagName === tagName) {
      return child;
    }
  }

  return null;
}

export async function importMusicXmlToScore(xml: string): Promise<ScoreDocument> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  if (doc.querySelector("parsererror")) {
    throw new Error("The provided MusicXML could not be parsed.");
  }

  const partElement = doc.querySelector("part");
  if (!partElement) {
    throw new Error("No playable part was found in the MusicXML document.");
  }

  const title =
    doc.querySelector("work > work-title")?.textContent?.trim() ||
    doc.querySelector("movement-title")?.textContent?.trim() ||
    "Untitled";
  const composer = doc.querySelector('identification > creator[type="composer"]')?.textContent?.trim() ?? "";

  let divisions = 1;
  let keySignature = "C";
  let timeSignature = "4/4";
  let tempoBpm = 120;

  const measures: ScoreMeasure[] = Array.from(partElement.querySelectorAll("measure")).map((measureElement, measureIndex) => {
    const notes: ScoreNote[] = [];
    let positionDivisions = 0;

    for (const child of Array.from(measureElement.children)) {
      if (child.tagName === "attributes") {
        const divisionsText = directChild(child, "divisions")?.textContent;
        if (divisionsText) {
          divisions = Number.parseInt(divisionsText, 10) || divisions;
        }

        const keyElement = directChild(child, "key");
        const fifthsText = keyElement ? directChild(keyElement, "fifths")?.textContent : null;
        if (fifthsText) {
          const fifths = Number.parseInt(fifthsText, 10);
          const mode = keyElement ? directChild(keyElement, "mode")?.textContent?.trim() : undefined;
          const table = mode === "minor" ? MINOR_KEY_BY_FIFTHS : MAJOR_KEY_BY_FIFTHS;
          keySignature = table[fifths] ?? keySignature;
        }

        const timeElement = directChild(child, "time");
        const beats = timeElement ? directChild(timeElement, "beats")?.textContent : null;
        const beatType = timeElement ? directChild(timeElement, "beat-type")?.textContent : null;
        if (beats && beatType) {
          timeSignature = `${beats}/${beatType}`;
        }
      }

      if (child.tagName === "direction") {
        const tempoAttr = child.querySelector("sound[tempo]")?.getAttribute("tempo");
        if (tempoAttr) {
          tempoBpm = Number.parseFloat(tempoAttr) || tempoBpm;
        }
      }

      if (child.tagName === "note") {
        const durationText = directChild(child, "duration")?.textContent;
        const durationTicks = durationText ? Number.parseInt(durationText, 10) : 0;
        const durationBeats = divisions > 0 ? durationTicks / divisions : 0;
        const isChord = directChild(child, "chord") !== null;
        const isRest = directChild(child, "rest") !== null;
        const startBeat = isChord ? (notes[notes.length - 1]?.startBeat ?? positionDivisions / divisions) : positionDivisions / divisions;

        const pitchElement = directChild(child, "pitch");
        if (!isRest && pitchElement) {
          const step = directChild(pitchElement, "step")?.textContent ?? "";
          const alter = Number.parseInt(directChild(pitchElement, "alter")?.textContent ?? "0", 10);
          const octave = directChild(pitchElement, "octave")?.textContent ?? "";
          const fingeringText = child.querySelector("notations > technical > fingering")?.textContent;

          notes.push({
            id: crypto.randomUUID(),
            pitch: pitchToNoteName(step, alter, octave),
            startBeat,
            durationBeats,
            fingering: fingeringText ? Number.parseInt(fingeringText, 10) : null
          });
        }

        if (!isChord) {
          positionDivisions += durationTicks;
        }
      }
    }

    return { index: measureIndex, notes };
  });

  if (measures.every((measure) => measure.notes.length === 0)) {
    throw new Error("No notes were found in the MusicXML document.");
  }

  return {
    title,
    composer,
    tempoBpm,
    keySignature,
    timeSignature,
    sourceType: "musicxml",
    measures,
    annotations: [],
    practiceHistory: []
  };
}
