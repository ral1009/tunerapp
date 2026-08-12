import { Accidental, Beam, Formatter, Renderer, Stave, StaveNote, Voice } from "vexflow";
import type { ScoreDocument, ScoreMeasure } from "../schema";

export interface RenderedScoreHandle {
  unmount(): void;
}

export interface ScoreRenderOptions {
  measuresPerRow?: number;
  staveWidth?: number;
}

const DURATION_TABLE: Array<[number, string]> = [
  [4, "w"],
  [3, "hd"],
  [2, "h"],
  [1.5, "qd"],
  [1, "q"],
  [0.75, "8d"],
  [0.5, "8"],
  [0.375, "16d"],
  [0.25, "16"],
  [0.125, "32"]
];

function beatsToVexDuration(beats: number): string {
  if (!Number.isFinite(beats) || beats <= 0) {
    return "q";
  }

  let closest = DURATION_TABLE[0];
  let closestDiff = Math.abs(beats - closest[0]);
  for (const entry of DURATION_TABLE) {
    const diff = Math.abs(beats - entry[0]);
    if (diff < closestDiff) {
      closest = entry;
      closestDiff = diff;
    }
  }

  return closest[1];
}

// Each ScoreNote becomes its own StaveNote — simultaneous notes (chords) are not
// grouped, since the app targets a single melodic line (violin) where chords don't occur.
function buildVexNotes(measure: ScoreMeasure): StaveNote[] {
  const notes: StaveNote[] = [];

  for (const scoreNote of measure.notes) {
    const parsed = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(scoreNote.pitch);
    if (!parsed) {
      continue;
    }

    const [, step, accidental, octave] = parsed;
    const key = `${step.toLowerCase()}${accidental}/${octave}`;
    const duration = beatsToVexDuration(scoreNote.durationBeats);

    const staveNote = new StaveNote({ keys: [key], duration });
    if (accidental) {
      staveNote.addModifier(new Accidental(accidental), 0);
    }

    notes.push(staveNote);
  }

  return notes;
}

export function renderScore(score: ScoreDocument, container: HTMLDivElement, options: ScoreRenderOptions = {}): RenderedScoreHandle {
  container.innerHTML = "";

  const measuresPerRow = options.measuresPerRow ?? 4;
  const staveWidth = options.staveWidth ?? 260;
  const measureCount = score.measures.length || 1;
  const columns = Math.min(measuresPerRow, measureCount);
  const rows = Math.ceil(measureCount / measuresPerRow);
  const rowHeight = 150;

  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(columns * staveWidth + 40, rows * rowHeight + 40);
  const context = renderer.getContext();
  context.setFont("Arial", 10);

  const [beatsPerMeasure, beatUnit] = score.timeSignature.split("/").map((part) => Number.parseInt(part, 10));

  score.measures.forEach((measure, measureIndex) => {
    const row = Math.floor(measureIndex / measuresPerRow);
    const col = measureIndex % measuresPerRow;
    const x = 20 + col * staveWidth;
    const y = 20 + row * rowHeight;

    const stave = new Stave(x, y, staveWidth);
    if (measureIndex === 0) {
      stave.addClef("treble");
      stave.addKeySignature(score.keySignature);
      stave.addTimeSignature(score.timeSignature);
    }
    stave.setContext(context).draw();

    const vexNotes = buildVexNotes(measure);
    if (vexNotes.length === 0) {
      return;
    }

    const voice = new Voice({ numBeats: beatsPerMeasure || 4, beatValue: beatUnit || 4 });
    voice.setStrict(false);
    voice.addTickables(vexNotes);

    new Formatter().joinVoices([voice]).format([voice], staveWidth - 40);
    voice.draw(context, stave);

    Beam.generateBeams(vexNotes).forEach((beam) => beam.setContext(context).draw());
  });

  return {
    unmount() {
      container.innerHTML = "";
    }
  };
}
