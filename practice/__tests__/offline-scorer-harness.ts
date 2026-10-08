// Standalone harness for practice/offlineIntonationScorer.ts. No Jest/Vitest in this repo -- run
// via `npm run offlineScorerTest` (tsx, same pattern as resync-harness.ts). Feeds the scorer plain
// data -- synthetic notes, a synthetic alignment path, a synthetic recording of known tones at known
// cents offsets -- so every expected verdict is exact and no OSMD/browser is needed.
import type { CursorNoteInfo, QuarterIndexEntry } from "../../score/renderer/scoreCursor";
import {
  OFFLINE_ANALYSIS_INTERVAL_SECONDS,
  OFFLINE_SMOOTHING_FRAMES,
  quarterAt,
  scoreRecordingOffline,
  stepIndexAt,
  type AlignmentPoint,
  type OfflineDetectorSetup,
  type OfflineScoringConfig
} from "../offlineIntonationScorer";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` -- ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const SAMPLE_RATE = 48_000;
const SECONDS_PER_QUARTER = 0.5; // 120 bpm

const DETECTOR: OfflineDetectorSetup = {
  sampleRate: SAMPLE_RATE,
  gainScalar: 1,
  silenceRmsThreshold: 0.005,
  frameSize: 4096,
  hopSize: Math.round(SAMPLE_RATE * OFFLINE_ANALYSIS_INTERVAL_SECONDS),
  confidenceThreshold: 0.67,
  lowCutHz: 80,
  highCutHz: 3500,
  smoothingWindowFrames: OFFLINE_SMOOTHING_FRAMES
};

const SCORING: OfflineScoringConfig = {
  inTuneCentsThreshold: 15,
  minSamplesForVerdict: 2,
  settleMs: 40,
  plausibilityHighConfidenceThreshold: 0.8,
  plausibilityLowConfidenceCentsLimit: 250,
  plausibilityAbsoluteCentsLimit: 1000
};

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function makeNotes(midis: number[]): CursorNoteInfo[] {
  return midis.map((midi, stepIndex) => ({
    stepIndex,
    measureIndex: Math.floor(stepIndex / 4),
    frequenciesHz: [midiToHz(midi)],
    primaryFrequencyHz: midiToHz(midi),
    pitchLabel: `N${stepIndex}`,
    isRest: false,
    durationQuarterNotes: 1,
    precedingRestQuarterNotes: 0
  }));
}

function quarterIndexFor(notes: CursorNoteInfo[]): QuarterIndexEntry[] {
  return notes.map((note) => ({ quarter: note.stepIndex, stepIndex: note.stepIndex }));
}

// A violin-ish tone: a few decaying harmonics, short fades so note boundaries don't click.
function renderTones(tones: Array<{ hz: number | null; seconds: number }>): Float32Array {
  const total = tones.reduce((sum, tone) => sum + Math.round(tone.seconds * SAMPLE_RATE), 0);
  const audio = new Float32Array(total);
  let offset = 0;
  for (const tone of tones) {
    const length = Math.round(tone.seconds * SAMPLE_RATE);
    for (let i = 0; i < length; i += 1) {
      const t = i / SAMPLE_RATE;
      const fade = Math.min(1, t / 0.01, (length / SAMPLE_RATE - t) / 0.01);
      let sample = 0;
      if (tone.hz !== null) {
        for (let k = 1; k <= 4; k += 1) {
          sample += Math.sin(2 * Math.PI * tone.hz * k * t) / k;
        }
        sample *= 0.2 * fade;
      }
      audio[offset + i] = sample + (Math.random() - 0.5) * 0.002;
    }
    offset += length;
  }
  return audio;
}

// A perfect alignment: quarter q is played at time q * SECONDS_PER_QUARTER + leadIn, sampled
// every 1/30 s like the server's chroma frames.
function linearPath(fromSeconds: number, toSeconds: number, leadInSeconds = 0): AlignmentPoint[] {
  const path: AlignmentPoint[] = [];
  for (let t = fromSeconds; t <= toSeconds + 1e-9; t += 1 / 30) {
    path.push({ perfTimeSeconds: t, quarter: (t - leadInSeconds) / SECONDS_PER_QUARTER });
  }
  return path;
}

function detuned(midi: number, cents: number): number {
  return midiToHz(midi) * Math.pow(2, cents / 1200);
}

async function main(): Promise<void> {
  console.log("\n1. helper edge cases");
  {
    const path: AlignmentPoint[] = [
      { perfTimeSeconds: 1, quarter: 0 },
      { perfTimeSeconds: 2, quarter: 2 }
    ];
    check("before the path -> null (not clamped to the first note)", quarterAt(path, 0.5) === null);
    check("after the path -> null (not clamped to the last note)", quarterAt(path, 2.5) === null);
    check("interpolates inside the path", Math.abs((quarterAt(path, 1.5) ?? -1) - 1) < 1e-9);
    const index: QuarterIndexEntry[] = [
      { quarter: 0, stepIndex: 0 },
      { quarter: 1, stepIndex: 1 },
      { quarter: 3, stepIndex: 2 }
    ];
    check("quarter inside a rest holds the previous note", stepIndexAt(index, 2.4) === 1);
    check("exact boundary lands on the new note", stepIndexAt(index, 3) === 2);
  }

  console.log("\n2. in-tune and out-of-tune notes are told apart");
  {
    // G4 in tune, A4 +40c sharp, B4 in tune, C5 -35c flat.
    const midis = [67, 69, 71, 72];
    const cents = [0, 40, 0, -35];
    const notes = makeNotes(midis);
    const audio = renderTones(midis.map((midi, i) => ({ hz: detuned(midi, cents[i]), seconds: SECONDS_PER_QUARTER })));
    const records = await scoreRecordingOffline(audio, linearPath(0, 4 * SECONDS_PER_QUARTER), notes, quarterIndexFor(notes), DETECTOR, SCORING);
    const verdicts = records.map((record) => record.verdict);
    check("one record per note", records.length === 4);
    check(
      "verdicts",
      verdicts.join(",") === "in_tune,out_of_tune,in_tune,out_of_tune",
      verdicts.join(",")
    );
    // 8c, not tighter: this checks the scorer reports what the detector reads, and the detector
    // itself reads a clean G4 (392 Hz at 48 kHz) about +6.4c sharp -- a pre-existing bias of
    // audio/pitchDetector.ts, measured directly on pure tones, that affects live grading equally.
    for (let i = 0; i < records.length; i += 1) {
      const measured = records[i].averageCentsOff ?? NaN;
      check(`note ${i} measured within 8c of ${cents[i]}c`, Math.abs(measured - cents[i]) < 8, `${measured.toFixed(1)}c from ${records[i].centsOffSamples.length} samples`);
    }
  }

  console.log("\n3. audio outside the aligned span is discarded, not dumped on the edge notes");
  {
    // 1s of a loud, badly wrong tone before and after the take. If it leaked into the first or
    // last note, those would come out wildly out of tune.
    const midis = [67, 69, 71, 72];
    const notes = makeNotes(midis);
    const lead = 1;
    const audio = renderTones([
      { hz: detuned(67, 300), seconds: lead },
      ...midis.map((midi) => ({ hz: midiToHz(midi), seconds: SECONDS_PER_QUARTER })),
      { hz: detuned(72, -300), seconds: 1 }
    ]);
    const records = await scoreRecordingOffline(
      audio,
      linearPath(lead, lead + 4 * SECONDS_PER_QUARTER, lead),
      notes,
      quarterIndexFor(notes),
      DETECTOR,
      SCORING
    );
    check("first note unaffected by lead-in", records[0].verdict === "in_tune", `${records[0].averageCentsOff?.toFixed(1)}c`);
    check("last note unaffected by trailing audio", records[3].verdict === "in_tune", `${records[3].averageCentsOff?.toFixed(1)}c`);
  }

  console.log("\n4. a note the alignment never reached is not played");
  {
    const midis = [67, 69, 71, 72];
    const notes = makeNotes(midis);
    // Player stopped after two notes; the path only covers those.
    const audio = renderTones(midis.slice(0, 2).map((midi) => ({ hz: midiToHz(midi), seconds: SECONDS_PER_QUARTER })));
    const records = await scoreRecordingOffline(audio, linearPath(0, 2 * SECONDS_PER_QUARTER), notes, quarterIndexFor(notes), DETECTOR, SCORING);
    check("played notes graded", records[0].verdict === "in_tune" && records[1].verdict === "in_tune");
    check("unreached notes not played", records[2].verdict === "not_played" && records[3].verdict === "not_played");
  }

  console.log("\n5. the settle window keeps a messy attack out of the grade");
  {
    // Each note opens with 60ms at +80c, then settles in tune. A wide settle window must grade
    // these in tune; no settle window lets the attack pull the median.
    const midis = [67, 69, 71, 72];
    const notes = makeNotes(midis);
    const attack = 0.12;
    const audio = renderTones(
      midis.flatMap((midi) => [
        { hz: detuned(midi, 80), seconds: attack },
        { hz: midiToHz(midi), seconds: SECONDS_PER_QUARTER - attack }
      ])
    );
    const path = linearPath(0, 4 * SECONDS_PER_QUARTER);
    // Frame method: its readings are individual frames, so attack frames can get in. The
    // score-informed method measures the whole span at once (section 7 covers it).
    const frame = { ...SCORING, method: "frame_detector" as const };
    const settled = await scoreRecordingOffline(audio, path, notes, quarterIndexFor(notes), DETECTOR, { ...frame, settleMs: 200 });
    const unsettled = await scoreRecordingOffline(audio, path, notes, quarterIndexFor(notes), DETECTOR, { ...frame, settleMs: 0 });
    // Sample counts aren't comparable (each note is capped at MAX_READINGS_PER_NOTE either way);
    // what matters is whether any reading from the +80c attack survived.
    const worstSettled = Math.max(...settled.flatMap((record) => record.centsOffSamples));
    const worstUnsettled = Math.max(...unsettled.flatMap((record) => record.centsOffSamples));
    check("without a settle window, attack readings get in", worstUnsettled > 60, `worst reading ${worstUnsettled.toFixed(0)}c`);
    check("with it, none do", worstSettled < 40, `worst reading ${worstSettled.toFixed(0)}c`);
    check(
      "with the settle window, all four grade in tune",
      settled.every((record) => record.verdict === "in_tune"),
      settled.map((record) => `${record.averageCentsOff?.toFixed(1)}c`).join(" ")
    );
  }

  console.log("\n7. score-informed method: fast notes over a louder ringing note, and wrong notes");
  {
    // Sixteenths at 120 bpm (125 ms) over a louder, slowly decaying open-D drone: the situation
    // that left most fast notes unreadable for the frame detector on real recordings.
    const midis = [69, 71, 73, 74, 76, 74, 73, 71];
    const offsets = [-30, 0, 20, -10, 35, 0, -20, 10];
    const sixteenth = SECONDS_PER_QUARTER / 4;
    const audio = renderTones(midis.map((midi, i) => ({ hz: detuned(midi, offsets[i]), seconds: sixteenth })));
    for (let i = 0; i < audio.length; i += 1) {
      const t = i / SAMPLE_RATE;
      let drone = 0;
      for (let k = 1; k <= 4; k += 1) drone += Math.sin(2 * Math.PI * midiToHz(62) * k * t) / k;
      audio[i] += 0.3 * drone * Math.exp(-0.5 * t);
    }
    const notes = makeNotes(midis).map((note) => ({ ...note, durationQuarterNotes: 0.25 }));
    const quarterIndex = notes.map((note) => ({ quarter: note.stepIndex * 0.25, stepIndex: note.stepIndex }));
    const path = linearPath(0, midis.length * sixteenth);
    const informed = await scoreRecordingOffline(audio, path, notes, quarterIndex, DETECTOR, SCORING);
    const frame = await scoreRecordingOffline(audio, path, notes, quarterIndex, DETECTOR, { ...SCORING, method: "frame_detector" });
    const errors = informed.map((record, i) => (record.averageCentsOff === null ? Infinity : Math.abs(record.averageCentsOff - offsets[i])));
    check(
      // ~70 ms of usable signal per note (125 ms minus settle and end guard) with stronger partials
      // nearby: a few cents is the resolution limit here, not a tuning target.
      "every note read, each within 10c of its true detune",
      errors.every((e) => e <= 10),
      informed.map((record, i) => `${record.averageCentsOff?.toFixed(1) ?? "-"}/${offsets[i]}`).join(" ")
    );
    check(
      "verdicts follow the true detune",
      informed.every((record, i) => record.verdict === (Math.abs(offsets[i]) <= SCORING.inTuneCentsThreshold ? "in_tune" : "out_of_tune"))
    );
    console.log(`       (frame detector on the same audio graded ${frame.filter((r) => r.averageCentsOff !== null).length}/${midis.length})`);

    // Every note played a minor third above what's written: none may come back in tune.
    const wrongAudio = renderTones(midis.map((midi) => ({ hz: midiToHz(midi + 3), seconds: sixteenth })));
    const wrong = await scoreRecordingOffline(wrongAudio, path, notes, quarterIndex, DETECTOR, SCORING);
    check(
      "wrong notes are never graded in tune",
      wrong.every((record) => record.verdict !== "in_tune"),
      wrong.map((record) => record.verdict).join(" ")
    );
  }

  console.log("\n6. degenerate inputs return nothing (the caller falls back to the live estimate)");
  {
    const notes = makeNotes([67, 69]);
    const audio = renderTones([{ hz: midiToHz(67), seconds: 1 }]);
    check("empty path", (await scoreRecordingOffline(audio, [], notes, quarterIndexFor(notes), DETECTOR, SCORING)).length === 0);
    check(
      "no notes",
      (await scoreRecordingOffline(audio, linearPath(0, 1), [], [], DETECTOR, SCORING)).length === 0
    );
  }

  console.log("\n7. jumps (\"Jump to bar\"): skipped notes are not played, a replayed bar counts its last attempt");
  {
    const midis = [67, 69, 71, 72, 74, 76, 78, 79];
    const notes = makeNotes(midis);
    const quarterIndex = quarterIndexFor(notes);
    const stretch = (fromSeconds: number, toSeconds: number, fromQuarter: number): AlignmentPoint[] =>
      linearPath(fromSeconds, toSeconds).map((point) => ({
        perfTimeSeconds: point.perfTimeSeconds,
        quarter: fromQuarter + (point.perfTimeSeconds - fromSeconds) / SECONDS_PER_QUARTER
      }));

    // Notes 0-1, then a jump to note 5 and notes 5-7.
    const forwardAudio = renderTones([0, 1, 5, 6, 7].map((i) => ({ hz: midiToHz(midis[i]), seconds: SECONDS_PER_QUARTER })));
    const forwardPath = [...stretch(0, 0.99, 0), ...stretch(1.0, 2.5, 5)];
    const forward = await scoreRecordingOffline(forwardAudio, forwardPath, notes, quarterIndex, DETECTOR, SCORING);
    check(
      "notes jumped over are not played",
      [2, 3, 4].every((i) => forward[i].verdict === "not_played"),
      forward.map((record) => record.verdict).join(" ")
    );
    check("notes either side of the jump are graded", [0, 1, 5, 6, 7].every((i) => forward[i].verdict === "in_tune"));

    // Notes 0-3 with note 2 played 50c sharp, then back to note 2 and notes 2-3 played in tune.
    const backAudio = renderTones([
      ...[0, 1].map((i) => ({ hz: midiToHz(midis[i]), seconds: SECONDS_PER_QUARTER })),
      { hz: detuned(midis[2], 50), seconds: SECONDS_PER_QUARTER },
      ...[3, 2, 3].map((i) => ({ hz: midiToHz(midis[i]), seconds: SECONDS_PER_QUARTER }))
    ]);
    const backPath = [...stretch(0, 1.99, 0), ...stretch(2.0, 3.0, 2)];
    const back = await scoreRecordingOffline(backAudio, backPath, notes, quarterIndex, DETECTOR, SCORING);
    check(
      "a replayed note is graded on its last attempt",
      back[2].verdict === "in_tune" && Math.abs(back[2].averageCentsOff ?? 99) < 10,
      `note 2: ${back[2].verdict} ${back[2].averageCentsOff?.toFixed(1)}`
    );
    check("notes before the replay are kept", back[0].verdict === "in_tune" && back[1].verdict === "in_tune");
  }

  console.log("\n8. a repeated pair (\"D D\") whose first note is off, with the alignment's split in the wrong place");
  {
    // E, D (50c flat), D (in tune), F#, each half a second with a short fade between (a bow change).
    const midis = [76, 74, 74, 78];
    const notes = makeNotes(midis);
    const quarterIndex = quarterIndexFor(notes);
    const audio = renderTones([
      { hz: midiToHz(76), seconds: 0.5 },
      { hz: detuned(74, -50), seconds: 0.5 },
      { hz: midiToHz(74), seconds: 0.5 },
      { hz: midiToHz(78), seconds: 0.5 }
    ]);
    // Correct where the pitch changes (0.5 s, 1.5 s); wrong between the two Ds (1.4 s, not 1.0 s) --
    // chroma can't see that boundary, so the alignment's split there is arbitrary.
    const path: AlignmentPoint[] = [];
    for (let t = 0; t <= 2 + 1e-9; t += 1 / 30) {
      const quarter = t < 0.5 ? t / 0.5 : t < 1.4 ? 1 + (t - 0.5) / 0.9 : t < 1.5 ? 2 + (t - 1.4) / 0.1 : 3 + (t - 1.5) / 0.5;
      path.push({ perfTimeSeconds: t, quarter });
    }
    const records = await scoreRecordingOffline(audio, path, notes, quarterIndex, DETECTOR, SCORING);
    check(
      "the flat first D is measured on its own audio",
      Math.abs((records[1].averageCentsOff ?? 0) + 50) < 10 && records[1].verdict === "out_of_tune",
      `D1 ${records[1].averageCentsOff?.toFixed(1)} (${records[1].verdict}), D2 ${records[2].averageCentsOff?.toFixed(1)}`
    );
    check("the in-tune second D stays in tune", records[2].verdict === "in_tune");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
