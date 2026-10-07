import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import WavDecoder from "wav-decoder";
import { scoreRecordingOffline, analysisFrameSizeFor, OFFLINE_ANALYSIS_INTERVAL_SECONDS, OFFLINE_SMOOTHING_FRAMES } from "../../practice/offlineIntonationScorer";
import { DEFAULT_MATCHMAKER_FOLLOWER_CONFIG as C } from "../../practice/matchmakerFollower";
import { gradeTake, DEFAULT_GRADING } from "../../practice/reviewSummary";

const DIR = "server/tmp/recordings/";
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
const cat = (c: number) => (Math.abs(c) <= 15 ? "in_tune" : Math.abs(c) <= 30 ? "close" : "out_of_tune");
const totals: Record<string, any> = {};
const pages: Record<string, any> = {};

for (const file of readdirSync(DIR).filter((f) => f.startsWith("beginner-") && f.endsWith(".replay.json")).sort()) {
  const replay = JSON.parse(readFileSync(DIR + file, "utf8"));
  const truth = JSON.parse(readFileSync(DIR + replay.name + ".truth.json", "utf8"));
  const wav = await WavDecoder.decode(readFileSync(DIR + replay.wav));
  const sr = wav.sampleRate;
  const notes = replay.notes.map((n: any) => ({ stepIndex: n.stepIndex, measureIndex: 0, frequenciesHz: [hz(n.midi)], primaryFrequencyHz: hz(n.midi), pitchLabel: null, isRest: false, durationQuarterNotes: n.dur, precedingRestQuarterNotes: 0 }));
  const records = await scoreRecordingOffline(wav.channelData[0], replay.path, notes, replay.notes.map((n: any) => ({ quarter: n.quarter, stepIndex: n.stepIndex })),
    { sampleRate: sr, gainScalar: 1, silenceRmsThreshold: 0.005, frameSize: analysisFrameSizeFor(sr, 2048), hopSize: Math.round(sr * OFFLINE_ANALYSIS_INTERVAL_SECONDS), confidenceThreshold: 0.67, lowCutHz: 80, highCutHz: 3500, smoothingWindowFrames: OFFLINE_SMOOTHING_FRAMES },
    { inTuneCentsThreshold: C.inTuneCentsThreshold, minSamplesForVerdict: C.minSamplesForVerdict, settleMs: C.onsetSettleMs, plausibilityHighConfidenceThreshold: C.plausibilityHighConfidenceThreshold, plausibilityLowConfidenceCentsLimit: C.plausibilityLowConfidenceCentsLimit, plausibilityAbsoluteCentsLimit: C.plausibilityAbsoluteCentsLimit });
  const profile = replay.name.split("-").slice(-1)[0] === "habit" ? "flat-habit" : replay.name.split("-").slice(-1)[0] === "tuned" ? "self-tuned" : "careful";
  const instrument = replay.recordingTuningCents;
  for (const mode of ["own", "a440"] as const) {
    const graded = gradeTake(records, { ...DEFAULT_GRADING, reference: mode });
    // Truth for "own": error relative to the instrument's own open strings; for "a440": absolute.
    const t = truth.map((x: any) => (mode === "own" ? x.cents - instrument : x.cents));
    const key = `${profile} / ${mode === "own" ? "my tuning" : "A440"}`;
    const agg = (totals[key] ??= { n: 0, unmeasured: 0, exact: 0, falseRed: 0, trulyFine: 0, slipsCaught: 0, slips: 0, absErr: [] as number[], closeTruth: 0, closeShown: 0, redTruth: 0 });
    graded.records.forEach((r, i) => {
      agg.n++;
      if (r.averageCentsOff === null) { agg.unmeasured++; return; }
      agg.absErr.push(Math.abs(r.averageCentsOff - t[i]));
      const truthCat = cat(t[i]);
      if (truthCat === r.verdict) agg.exact++;
      if (truthCat === "in_tune") { agg.trulyFine++; if (r.verdict === "out_of_tune") agg.falseRed++; }
      if (truthCat === "close") { agg.closeTruth++; if (r.verdict !== "in_tune") agg.closeShown++; }
      if (truthCat === "out_of_tune") { agg.redTruth++; if (r.verdict === "out_of_tune") agg.slipsCaught++; }
    });
    if (mode === "own") pages[replay.name] = { reference: graded.referenceCents, source: graded.referenceSource, notes: graded.records.map((r, i) => ({ quarter: replay.notes[i].quarter, midi: replay.notes[i].midi, verdict: r.verdict, cents: r.averageCentsOff, truthCents: t[i] })) };
  }
}
for (const [key, a] of Object.entries(totals)) {
  const e = [...a.absErr].sort((x: number, y: number) => x - y);
  console.log(`${key.padEnd(26)} notes ${a.n} | unclear ${a.unmeasured} | verdict matches truth ${(100 * a.exact / (a.n - a.unmeasured)).toFixed(0)}% | truly-fine notes marked red ${a.falseRed}/${a.trulyFine} | real mistakes marked red ${a.slipsCaught}/${a.redTruth} | slightly-off shown amber/red ${a.closeShown}/${a.closeTruth} | cents error median ${e[Math.floor(e.length / 2)].toFixed(1)} p95 ${e[Math.floor(e.length * 0.95)].toFixed(1)}`);
}
writeFileSync("server/tmp/recordings/beginner_results.json", JSON.stringify(pages));
