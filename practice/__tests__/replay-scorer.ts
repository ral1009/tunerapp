// Grades real recordings with the app's own post-take scorer (practice/offlineIntonationScorer.ts),
// using the alignment paths server/replay_check.py writes. Run that first, then
// `npm run replayScore`. No test framework, same as the other harnesses: it prints numbers to
// compare between runs, it doesn't pass or fail.
//
// Each take is graded twice: against the written notes, and against a CONTROL where every note is
// graded against the next different written pitch. A scorer that is really measuring the audio
// should call far fewer control notes in tune. If the two runs look alike, the scorer is accepting
// whatever it's told to look for.
//
// The notes here come from partitura (replay_check.py), not OSMD, so stepIndex/quarter won't match
// the browser's ScoreCursor exactly on scores with grace notes or voices -- fine for comparing runs.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WavDecoder from "wav-decoder";
import type { CursorNoteInfo, QuarterIndexEntry } from "../../score/renderer/scoreCursor";
import { DEFAULT_MATCHMAKER_FOLLOWER_CONFIG } from "../matchmakerFollower";
import {
  OFFLINE_ANALYSIS_INTERVAL_SECONDS,
  OFFLINE_SMOOTHING_FRAMES,
  analysisFrameSizeFor,
  scoreRecordingOffline,
  type AlignmentPoint
} from "../offlineIntonationScorer";

const DIR = join("server", "tmp", "recordings");

interface Replay {
  name: string;
  heldOut: boolean;
  wav: string;
  path: AlignmentPoint[];
  notes: Array<{ stepIndex: number; quarter: number; midi: number; dur: number }>;
  recordingTuningCents: number;
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const median = (values: number[]) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function grade(replay: Replay, audio: Float32Array, sampleRate: number, control: boolean, method: "score_informed" | "frame_detector") {
  const midiFor = (i: number): number => {
    const own = replay.notes[i].midi;
    if (!control) return own;
    for (let j = i + 1; j < replay.notes.length; j += 1) {
      if (replay.notes[j].midi !== own) return replay.notes[j].midi;
    }
    return own + 2;
  };
  const notes: CursorNoteInfo[] = replay.notes.map((note, i) => ({
    stepIndex: note.stepIndex,
    measureIndex: 0,
    frequenciesHz: [hz(midiFor(i))],
    primaryFrequencyHz: hz(midiFor(i)),
    pitchLabel: null,
    isRest: false,
    durationQuarterNotes: note.dur,
    precedingRestQuarterNotes: 0
  }));
  const quarterIndex: QuarterIndexEntry[] = replay.notes.map((note) => ({ quarter: note.quarter, stepIndex: note.stepIndex }));
  const config = DEFAULT_MATCHMAKER_FOLLOWER_CONFIG;
  // Same settings App.tsx passes, except the calibrated mic values: these are clean recordings, so
  // unity gain and the capture module's default noise floor.
  const records = await scoreRecordingOffline(
    audio,
    replay.path,
    notes,
    quarterIndex,
    {
      sampleRate,
      gainScalar: 1,
      silenceRmsThreshold: 0.005,
      frameSize: analysisFrameSizeFor(sampleRate, 2048),
      hopSize: Math.round(sampleRate * OFFLINE_ANALYSIS_INTERVAL_SECONDS),
      confidenceThreshold: 0.67,
      lowCutHz: 80,
      highCutHz: 3500,
      smoothingWindowFrames: OFFLINE_SMOOTHING_FRAMES
    },
    {
      inTuneCentsThreshold: config.inTuneCentsThreshold,
      minSamplesForVerdict: config.minSamplesForVerdict,
      settleMs: config.onsetSettleMs,
      plausibilityHighConfidenceThreshold: config.plausibilityHighConfidenceThreshold,
      plausibilityLowConfidenceCentsLimit: config.plausibilityLowConfidenceCentsLimit,
      plausibilityAbsoluteCentsLimit: config.plausibilityAbsoluteCentsLimit,
      method
    }
  );
  const counts: Record<string, number> = { in_tune: 0, out_of_tune: 0, unmeasured: 0, not_played: 0 };
  for (const record of records) counts[record.verdict] = (counts[record.verdict] ?? 0) + 1;
  const cents = records.map((record) => record.averageCentsOff).filter((value): value is number => value !== null);
  return { counts, cents, total: records.length, records };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const files = readdirSync(DIR).filter((file) => file.endsWith(".replay.json"));
  if (files.length === 0) {
    console.log(`No replays in ${DIR} -- run python server/replay_check.py first.`);
    return;
  }
  for (const file of files.sort()) {
    const replay: Replay = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    if (only.length > 0 && !only.includes(replay.name)) continue;
    const wav = await WavDecoder.decode(readFileSync(join(DIR, replay.wav)));
    const audio = wav.channelData[0];
    const started = Date.now();
    const real = await grade(replay, audio, wav.sampleRate, false, "score_informed");
    // Per-note verdicts for drawing on the score (server/tmp/recordings/<name>.verdicts.json).
    writeFileSync(
      join(DIR, `${replay.name}.verdicts.json`),
      JSON.stringify(
        real.records.map((record, i) => ({
          stepIndex: record.stepIndex,
          quarter: replay.notes[i].quarter,
          midi: replay.notes[i].midi,
          verdict: record.verdict,
          cents: record.averageCentsOff
        }))
      )
    );
    const seconds = (Date.now() - started) / 1000;
    const control = await grade(replay, audio, wav.sampleRate, true, "score_informed");
    const frame = await grade(replay, audio, wav.sampleRate, false, "frame_detector");
    const frameControl = await grade(replay, audio, wav.sampleRate, true, "frame_detector");
    const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(0)}%`;
    const line = (label: string, r: typeof real) =>
      `  ${label}: in tune ${pct(r.counts.in_tune, r.total)}, out of tune ${pct(r.counts.out_of_tune, r.total)}, ` +
      `unmeasured ${pct(r.counts.unmeasured, r.total)}, not played ${pct(r.counts.not_played, r.total)} | ` +
      `median ${median(r.cents).toFixed(1)}c, median |err| ${median(r.cents.map(Math.abs)).toFixed(1)}c, ` +
      `>100c ${r.cents.filter((c) => Math.abs(c) > 100).length}`;
    console.log(`\n=== ${replay.name}${replay.heldOut ? " [HELD OUT]" : ""}: ${real.total} notes, scored in ${seconds.toFixed(1)}s`);
    console.log(line("score-informed            ", real));
    console.log(line("score-informed CONTROL    ", control));
    console.log(line("frame detector (previous) ", frame));
    console.log(line("frame detector CONTROL    ", frameControl));
    console.log(
      `  recording tuning per pYIN ${replay.recordingTuningCents.toFixed(1)}c -- the app's median reading should sit near this, not near 0`
    );
  }
}

void main();
