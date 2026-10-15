// On-device alignment vs the server, on real recordings. No Jest/Vitest in this repo -- run via
// `npm run deviceAlignTest` (tsx). Fixtures come from `python server/export_alignment_fixtures.py`
// (server/tmp/fixtures/<case>/, gitignored): what the server's matchmaker pipeline computed, step
// by step. Each stage of the port is compared against the same stage there, so a mismatch points
// at the stage that caused it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { scoreNotes } from "../../score/scoreNotes";
import { join } from "node:path";

import { ArztFollower } from "../onDevice/arztFollower";
import { chromaFrames, chromaOfFrame } from "../onDevice/chroma";
import { alignTake, type TakeSeek } from "../onDevice/offlineAlign";
import { buildReference, DeviceAligner } from "../onDevice/deviceAligner";
import { bandStats, PlayingGate } from "../onDevice/playingGate";
import type { CursorNoteInfo, QuarterIndexEntry } from "../../score/renderer/scoreCursor";
import { DEFAULT_MATCHMAKER_FOLLOWER_CONFIG } from "../matchmakerFollower";
import {
  OFFLINE_ANALYSIS_INTERVAL_SECONDS,
  OFFLINE_SMOOTHING_FRAMES,
  analysisFrameSizeFor,
  scoreRecordingOffline,
  type AlignmentPoint,
  type OfflineDetectorSetup,
  type OfflineScoringConfig
} from "../offlineIntonationScorer";
import { referenceAudio, refFrameQuarters, type ReferenceNote } from "../onDevice/referenceAudio";

const FIXTURES = join(__dirname, "..", "..", "server", "tmp", "fixtures");

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) passed += 1;
  else failed += 1;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`);
}

function f32(path: string): Float32Array {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

interface Meta {
  name: string;
  sampleRate: number;
  hop: number;
  nFft: number;
  tempo: number;
  refTuning: number;
  quarterOrigin: number;
  liveTuning: number[];
  liveLow: number[];
  liveRms: number[];
  releasedPerChunk: number[];
  followerFrames: number[];
  seeks: { chunk: number; quarter: number }[];
  refFrameQuarter: number[];
  gate: { accepted: number; rejected: number };
  notes: ReferenceNote[];
  offlinePath: [number, number][];
  grading: { kind: "replay" | "take"; path: string } | null;
}

// The server's quarter_to_ref_frame: first reference frame at or after the quarter.
function quarterToRefFrame(refFrameQuarter: number[], quarter: number): number {
  let lo = 0;
  let hi = refFrameQuarter.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (refFrameQuarter[mid] < quarter - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, refFrameQuarter.length - 1);
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

// Grading inputs for a fixture: the app's own saved-take settings for a user take, or the
// replay harness's (practice/__tests__/replay-scorer.ts) for a recording.
function gradingInputs(meta: Meta, sampleRate: number): { notes: CursorNoteInfo[]; quarterIndex: QuarterIndexEntry[]; setup: OfflineDetectorSetup; config: OfflineScoringConfig } | null {
  if (!meta.grading || !existsSync(meta.grading.path)) return null;
  const source = JSON.parse(readFileSync(meta.grading.path, "utf8"));
  if (meta.grading.kind === "take") return { notes: source.notes, quarterIndex: source.quarterIndex, setup: source.detectorSetup, config: source.scoringConfig };
  const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
  const notes: CursorNoteInfo[] = source.notes.map((n: { stepIndex: number; midi: number; dur: number }) => ({
    stepIndex: n.stepIndex, measureIndex: 0, frequenciesHz: [hz(n.midi)], primaryFrequencyHz: hz(n.midi), pitchLabel: null, isRest: false, durationQuarterNotes: n.dur, precedingRestQuarterNotes: 0
  }));
  const quarterIndex = source.notes.map((n: { quarter: number; stepIndex: number }) => ({ quarter: n.quarter, stepIndex: n.stepIndex }));
  const c = DEFAULT_MATCHMAKER_FOLLOWER_CONFIG;
  return {
    notes,
    quarterIndex,
    setup: { sampleRate, gainScalar: 1, silenceRmsThreshold: 0.005, frameSize: analysisFrameSizeFor(sampleRate, 2048), hopSize: Math.round(sampleRate * OFFLINE_ANALYSIS_INTERVAL_SECONDS), confidenceThreshold: 0.67, lowCutHz: 80, highCutHz: 3500, smoothingWindowFrames: OFFLINE_SMOOTHING_FRAMES },
    config: { inTuneCentsThreshold: c.inTuneCentsThreshold, minSamplesForVerdict: c.minSamplesForVerdict, settleMs: c.onsetSettleMs, plausibilityHighConfidenceThreshold: c.plausibilityHighConfidenceThreshold, plausibilityLowConfidenceCentsLimit: c.plausibilityLowConfidenceCentsLimit, plausibilityAbsoluteCentsLimit: c.plausibilityAbsoluteCentsLimit }
  };
}

const toPoints = (path: [number, number][]): AlignmentPoint[] => path.map(([perfTimeSeconds, quarter]) => ({ perfTimeSeconds, quarter }));

// Stage 0: the note list and tempo the reference is built from, vs partitura on every score the
// server has cached and the synthetic edge cases (server/export_score_note_fixtures.py).
function checkScores(): void {
  const dir = join(FIXTURES, "_scores");
  if (!existsSync(dir)) {
    console.log("No score fixtures. Run: python server/export_score_note_fixtures.py");
    return;
  }
  console.log("\nScores vs partitura");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const want = JSON.parse(readFileSync(join(dir, file), "utf8")) as { score: string; unfolded: boolean; tempo: number; notes: ReferenceNote[] };
    if (!existsSync(want.score)) continue;
    const doc = new DOMParser().parseFromString(readFileSync(want.score, "utf8"), "application/xml") as unknown as Document;
    const got = scoreNotes(doc);
    // partitura keeps positions as float32 beats, so its quarters carry ~1e-5 of rounding: match
    // each of its notes to one of ours with the same pitch within 1e-3 of a quarter.
    const pool = [...got.notes];
    const missing: string[] = [];
    for (const n of want.notes) {
      const i = pool.findIndex((m) => m.pitch === n.pitch && Math.abs(m.onsetQuarter - n.onsetQuarter) < 1e-3 && Math.abs(m.durationQuarter - n.durationQuarter) < 1e-3);
      if (i < 0) missing.push(`${n.onsetQuarter.toFixed(3)}:${n.pitch}:${n.durationQuarter.toFixed(3)}`);
      else pool.splice(i, 1);
    }
    const extra = pool.map((n) => `${n.onsetQuarter.toFixed(3)}:${n.pitch}:${n.durationQuarter.toFixed(3)}`);
    const a = got.notes;
    const b = want.notes;
    const label = file.replace(/\.json$/, "").slice(0, 24);
    const note = want.unfolded ? "" : " (partitura couldn't unfold; matchmaker used it as written)";
    check(`${label} notes`, missing.length === 0 && extra.length === 0, `${a.length} vs ${b.length}${missing.length ? `, missing ${missing.slice(0, 3).join(" ")}` : ""}${extra.length ? `, extra ${extra.slice(0, 3).join(" ")}` : ""}${note}`);
    check(`${label} tempo`, Math.abs(got.tempo - want.tempo) < 1e-9, `${got.tempo} vs ${want.tempo}`);
  }
}

async function main(): Promise<void> {
const only = process.argv.slice(2);
if (!only.length || only.includes("scores")) checkScores();
const recordingFilters = only.filter((o) => o !== "scores");
const cases = existsSync(FIXTURES)
  ? readdirSync(FIXTURES).filter((c) => !c.startsWith("_") && (only.length ? recordingFilters.some((o) => c.includes(o)) : true))
  : [];
if (!cases.length && !only.includes("scores")) {
  console.log("No fixtures. Run: python server/export_alignment_fixtures.py");
  process.exit(1);
}

for (const name of cases) {
  const dir = join(FIXTURES, name);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
  console.log(`\n${name} (${meta.sampleRate} Hz, hop ${meta.hop}, n_fft ${meta.nFft})`);

  // Stage 1: reference chroma from the server's reference audio (one tuning for the whole signal).
  const refAudio = f32(join(dir, "ref_audio.f32"));
  const refChroma = f32(join(dir, "ref_chroma.f32"));
  let t0 = performance.now();
  const ref = chromaFrames(refAudio, meta.sampleRate, meta.hop, meta.nFft);
  const refMs = performance.now() - t0;
  check("reference tuning", Math.abs(ref.tuning - meta.refTuning) < 1e-9, `${ref.tuning} vs ${meta.refTuning}`);
  check("reference frame count", ref.frames * 12 === refChroma.length, `${ref.frames} vs ${refChroma.length / 12}`);
  const refDiff = maxAbsDiff(ref.chroma, refChroma);
  check("reference chroma", refDiff <= 1e-3, `max |diff| ${refDiff.toExponential(2)}, ${refMs.toFixed(0)} ms`);

  // Stage 1b: the reference built here from the MusicXML (our note list, tempo, meter), and its
  // frame -> quarter map.
  const parsed = scoreNotes(new DOMParser().parseFromString(readFileSync(join(dir, "score.musicxml"), "utf8"), "application/xml") as unknown as Document);
  check("tempo", Math.abs(parsed.tempo - meta.tempo) < 1e-9, `${parsed.tempo} vs ${meta.tempo}`);
  check("score start", Math.abs(parsed.quarterOrigin - meta.quarterOrigin) < 1e-9, `${parsed.quarterOrigin} vs ${meta.quarterOrigin}`);
  t0 = performance.now();
  const synth = referenceAudio(parsed.notes, parsed.tempo, meta.sampleRate, { meter: parsed.meter, quarterOrigin: parsed.quarterOrigin });
  const synthMs = performance.now() - t0;
  check("reference audio length", synth.length === refAudio.length, `${synth.length} vs ${refAudio.length}`);
  const synthDiff = maxAbsDiff(synth, refAudio);
  check("reference audio samples", synthDiff <= 1e-4, `max |diff| ${synthDiff.toExponential(2)}, ${synthMs.toFixed(0)} ms`);
  const synthChroma = chromaFrames(synth, meta.sampleRate, meta.hop, meta.nFft);
  const synthChromaDiff = maxAbsDiff(synthChroma.chroma, refChroma);
  check("reference chroma from our synth", synthChroma.frames === ref.frames && synthChromaDiff <= 1e-3, `max |diff| ${synthChromaDiff.toExponential(2)}`);
  const fq = refFrameQuarters(ref.frames, meta.sampleRate / meta.hop, parsed.tempo, parsed.quarterOrigin);
  let fqWorst = 0;
  for (let i = 0; i < ref.frames; i += 1) fqWorst = Math.max(fqWorst, Math.abs(fq[i] - meta.refFrameQuarter[i]));
  check("reference frame -> quarter", fqWorst <= 1e-6, `max |diff| ${fqWorst.toExponential(2)}`);

  // Stage 2: live chroma, one frame per chunk (tuning per frame).
  const audio = f32(join(dir, "audio.f32"));
  const liveChroma = f32(join(dir, "live_chroma.f32"));
  const frames = liveChroma.length / 12;
  let tuningMismatch = 0;
  let worst = 0;
  let worstFrame = -1;
  t0 = performance.now();
  for (let i = 0; i < frames; i += 1) {
    const { chroma, tuning } = chromaOfFrame(audio, i * meta.hop, meta.sampleRate, meta.nFft);
    if (Math.abs(tuning - meta.liveTuning[i]) > 1e-9) tuningMismatch += 1;
    const d = maxAbsDiff(chroma, liveChroma.subarray(i * 12, i * 12 + 12));
    if (d > worst) {
      worst = d;
      worstFrame = i;
    }
  }
  const liveMs = (performance.now() - t0) / Math.max(1, frames);
  check("live tuning per frame", tuningMismatch === 0, `${tuningMismatch}/${frames} frames differ`);
  check("live chroma", worst <= 1e-3, `max |diff| ${worst.toExponential(2)} (frame ${worstFrame}), ${liveMs.toFixed(2)} ms/frame`);

  // Stage 3: the live pass end to end on the port's own chroma -- gate, then follower -- chunk by
  // chunk like the stream (chunk 0's frame is dropped; frame i covers chunks i-1 and i).
  const gate = new PlayingGate<Float32Array>();
  const follower = new ArztFollower(ref.chroma, meta.sampleRate / meta.hop);
  const chunks = meta.releasedPerChunk.length;
  const released: number[] = [];
  const followed: number[] = [];
  let lowWorst = 0;
  const takeSeeks: TakeSeek[] = [];
  t0 = performance.now();
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    for (const seek of meta.seeks) {
      if (seek.chunk !== chunk) continue;
      const target = quarterToRefFrame(meta.refFrameQuarter, seek.quarter);
      takeSeeks.push({ sample: chunk * meta.hop, target, liveBefore: follower.currentFrame });
      follower.seek(target);
    }
    if (chunk === 0) {
      released.push(0);
      continue;
    }
    const offset = (chunk - 1) * meta.hop;
    const { chroma } = chromaOfFrame(audio, offset, meta.sampleRate, meta.nFft);
    const { low, rms } = bandStats(audio, offset, meta.nFft, meta.sampleRate);
    lowWorst = Math.max(lowWorst, Math.abs(low - meta.liveLow[chunk - 1]));
    void rms;
    const out = gate.push(chroma, chroma, 0, low, rms);
    released.push(out.length);
    for (const frame of out) {
      follower.step(frame);
      followed.push(follower.currentFrame);
    }
  }
  const passMs = (performance.now() - t0) / chunks;
  const gateDiffs = released.reduce((n, r, i) => n + (r !== meta.releasedPerChunk[i] ? 1 : 0), 0);
  check("gate decisions", gateDiffs === 0, `${gateDiffs}/${chunks} chunks differ; accepted ${gate.accepted} vs ${meta.gate.accepted}, low-band max |diff| ${lowWorst.toExponential(1)}`);
  let same = 0;
  let worstOff = 0;
  for (let i = 0; i < Math.min(followed.length, meta.followerFrames.length); i += 1) {
    const off = Math.abs(followed[i] - meta.followerFrames[i]);
    if (off === 0) same += 1;
    worstOff = Math.max(worstOff, off);
  }
  const total = meta.followerFrames.length;
  check("live follower steps", followed.length === total, `${followed.length} vs ${total}`);
  check("live follower frames", same / Math.max(1, total) >= 0.995 && worstOff <= 1, `${same}/${total} identical, worst ${worstOff} frames off, ${passMs.toFixed(2)} ms/chunk`);

  // Stage 4: the post-take alignment over exactly the audio that was pushed.
  const take = audio.subarray(0, chunks * meta.hop);
  t0 = performance.now();
  const path = alignTake({
    take,
    sampleRate: meta.sampleRate,
    hop: meta.hop,
    nFft: meta.nFft,
    reference: ref.chroma,
    refFrameQuarter: fq,
    seeks: takeSeeks,
    liveFinal: follower.currentFrame,
  });
  const offMs = performance.now() - t0;
  const want = meta.offlinePath;
  let dt = 0;
  let dq = 0;
  for (let i = 0; i < Math.min(path.length, want.length); i += 1) {
    dt = Math.max(dt, Math.abs(path[i][0] - want[i][0]));
    dq = Math.max(dq, Math.abs(path[i][1] - want[i][1]));
  }
  const oneFrameQ = meta.tempo / 60 / (meta.sampleRate / meta.hop);
  let differing = 0;
  const firstDiffs: string[] = [];
  for (let i = 0; i < Math.min(path.length, want.length); i += 1) {
    if (Math.abs(path[i][1] - want[i][1]) > 1e-9) {
      differing += 1;
      if (firstDiffs.length < 4) firstDiffs.push(`#${i} t=${path[i][0].toFixed(2)} ${path[i][1].toFixed(3)} vs ${want[i][1].toFixed(3)}`);
    }
  }
  console.log(`       points differing: ${differing}/${want.length} ${firstDiffs.join("; ")}`);
  // Given the server's own take features this DTW reproduces its path exactly (checked while
  // porting). Ours differ from them by ~2e-6 -- float32 rounding in the filter-bank sum, whose
  // order depends on the server's BLAS -- and that is enough to tip a few near-ties inside held
  // notes, where neighbouring reference frames cost almost the same: a short run of points a few
  // frames apart. The server gives the same kind of difference on another machine. What matters is
  // the grades (stage 5); here, bound how much of the path that can affect.
  check("post-take path points", path.length === want.length, `${path.length} vs ${want.length}`);
  check(
    "post-take path",
    dt <= 1e-6 && differing <= 0.05 * want.length && dq <= 6 * oneFrameQ + 1e-9,
    `${differing}/${want.length} points differ, max |dq| ${(dq / oneFrameQ).toFixed(1)} frames, ${offMs.toFixed(0)} ms for ${(take.length / meta.sampleRate).toFixed(0)} s`
  );
  const lastQ = path.length ? path[path.length - 1][1] : NaN;
  const wantLastQ = want.length ? want[want.length - 1][1] : NaN;
  check("post-take end", Math.abs(lastQ - wantLastQ) < 1e-9, `${lastQ?.toFixed(3)} vs ${wantLastQ?.toFixed(3)}`);

  // Stage 6: the whole session as the app runs it -- reference built from the MusicXML, audio
  // pushed in odd-sized pieces (not hop-aligned), jumps at the same chunks -- must give the same
  // live positions and post-take path as the stages above.
  t0 = performance.now();
  const reference = buildReference(parsed, meta.sampleRate);
  const prepMs = performance.now() - t0;
  const aligner = new DeviceAligner(reference);
  const positions: number[] = [];
  let pushed = 0;
  const pieceSize = 1000;
  t0 = performance.now();
  for (let chunk = 0; chunk <= chunks; chunk += 1) {
    const upTo = Math.min(take.length, chunk * meta.hop);
    while (pushed < upTo) {
      const end = Math.min(upTo, pushed + pieceSize);
      const q = aligner.push(take.subarray(pushed, end));
      if (q !== null) positions.push(q);
      pushed = end;
    }
    for (const seek of meta.seeks) if (seek.chunk === chunk) aligner.seek(seek.quarter);
  }
  const liveTotalMs = performance.now() - t0;
  t0 = performance.now();
  const sessionPath = aligner.finish();
  const finishMs = performance.now() - t0;
  const samePath = sessionPath.length === path.length && sessionPath.every((p, i) => p[0] === path[i][0] && p[1] === path[i][1]);
  check("session post-take path = stage 4", samePath, `${sessionPath.length} points; prepare ${prepMs.toFixed(0)} ms, live ${(liveTotalMs / chunks).toFixed(2)} ms/chunk, finish ${finishMs.toFixed(0)} ms`);
  const lastLive = positions.length ? positions[positions.length - 1] : NaN;
  const serverLast = meta.refFrameQuarter[Math.min(meta.followerFrames[meta.followerFrames.length - 1] ?? 0, meta.refFrameQuarter.length - 1)];
  check("session live end = server", Math.abs(lastLive - serverLast) < 1e-9, `${lastLive.toFixed(3)} vs ${serverLast?.toFixed(3)}`);

  // Stage 5: what the player sees -- every note graded from our path vs from the server's.
  const inputs = gradingInputs(meta, meta.sampleRate);
  if (!inputs) {
    console.log("       (no grading inputs for this case)");
    continue;
  }
  const [mineRecords, serverRecords] = await Promise.all([
    scoreRecordingOffline(take, toPoints(path), inputs.notes, inputs.quarterIndex, inputs.setup, inputs.config),
    scoreRecordingOffline(take, toPoints(want), inputs.notes, inputs.quarterIndex, inputs.setup, inputs.config)
  ]);
  // Two graded notes may only disagree when one sits within 0.2 cents of the in-tune threshold,
  // where the same rounding noise decides which side of the line it falls. A note may also flip
  // between graded and "too quick to measure" when it sits on the edge of the score-informed
  // presence test (a one-frame shift in its aligned span decides it) -- allowed for at most 0.5%
  // of notes.
  let verdictDiffs = 0;
  let boundaryDiffs = 0;
  let presenceDiffs = 0;
  let centsWorst = 0;
  const tally: Record<string, number> = {};
  serverRecords.forEach((r, i) => {
    const m = mineRecords[i];
    tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
    if (m.averageCentsOff !== null && r.averageCentsOff !== null) centsWorst = Math.max(centsWorst, Math.abs(m.averageCentsOff - r.averageCentsOff));
    if (m.verdict === r.verdict) return;
    if (m.verdict === "unmeasured" || r.verdict === "unmeasured") {
      presenceDiffs += 1;
      console.log(`       note ${i}: ours ${m.verdict} ${m.averageCentsOff?.toFixed(2)}, server ${r.verdict} ${r.averageCentsOff?.toFixed(2)}`);
      return;
    }
    const nearEdge = [m.averageCentsOff, r.averageCentsOff].some((c) => c !== null && Math.abs(Math.abs(c) - inputs.config.inTuneCentsThreshold) < 0.2);
    if (nearEdge) boundaryDiffs += 1;
    else verdictDiffs += 1;
    console.log(`       note ${i}: ours ${m.verdict} ${m.averageCentsOff?.toFixed(2)}, server ${r.verdict} ${r.averageCentsOff?.toFixed(2)}`);
  });
  const summary = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ");
  check(
    "grades",
    verdictDiffs === 0 && presenceDiffs <= 0.005 * serverRecords.length,
    `${verdictDiffs} verdicts differ (+${boundaryDiffs} within 0.2 cents of the threshold, +${presenceDiffs} graded vs unmeasured) of ${serverRecords.length}, max cents diff ${centsWorst.toFixed(2)}; server: ${summary}`
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}

void main();
