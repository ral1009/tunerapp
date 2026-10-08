// Re-scores a take downloaded from the app ("Download this take") with exactly the settings the app
// used, checks the result reproduces what the app showed, and breaks it down by bar.
//
//   npm run replayTake -- path/to/take-<time>.json [path/to/take-<time>.wav]
//
// The WAV defaults to the JSON's name with .wav. Re-alignment isn't done here -- the take carries
// the server's own alignment path; to re-align the audio, feed the WAV and scoreXml to
// server/replay_check.py's LiveAligner path.
import { readFileSync } from "node:fs";
import WavDecoder from "wav-decoder";
import { scoreRecordingOffline } from "../offlineIntonationScorer";
import { DEFAULT_GRADING, gradeTake } from "../reviewSummary";
import type { SavedTake } from "../takeExport";

async function main(): Promise<void> {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.log("usage: npm run replayTake -- take.json [take.wav]");
    return;
  }
  const wavPath = process.argv[3] ?? jsonPath.replace(/\.json$/i, ".wav");
  const take: SavedTake = JSON.parse(readFileSync(jsonPath, "utf8"));
  const wav = await WavDecoder.decode(readFileSync(wavPath));
  const audio = wav.channelData[0];
  console.log(`take saved ${take.savedAt}: ${(audio.length / wav.sampleRate).toFixed(1)} s of audio at ${wav.sampleRate} Hz, ` +
    `${take.notes.length} notes, alignment path ${take.path.length} points (${take.scoringSource ?? "?"} grades in the app)`);
  if (take.path.length > 0) {
    const last = take.path[take.path.length - 1];
    console.log(`alignment reached quarter ${last.quarter.toFixed(1)} at ${last.perfTimeSeconds.toFixed(1)} s`);
  }

  const records = take.path.length > 0
    ? await scoreRecordingOffline(audio, take.path, take.notes, take.quarterIndex, take.detectorSetup, take.scoringConfig)
    : [];
  const same = records.length === take.history.length &&
    // The WAV stores 16-bit samples, so cents can differ by a few thousandths from the app's
    // float32 run; verdicts must match exactly.
    records.every((r, i) => r.verdict === take.history[i].verdict && Math.abs((r.averageCentsOff ?? 0) - (take.history[i].averageCentsOff ?? 0)) < 0.05);
  console.log(records.length ? `re-scored: ${same ? "matches" : "DIFFERS FROM"} what the app showed` : "no alignment path in the take -- the app used live grades");

  const graded = gradeTake(records.length ? records : take.history, DEFAULT_GRADING);
  console.log(`graded against own tuning: reference ${graded.referenceCents.toFixed(1)} cents from A440 (${graded.referenceSource})`);

  // Per bar: counts by verdict, and the time the alignment reached the bar's first note.
  const byBar = new Map<number, { notes: number; counts: Record<string, number>; firstQuarter: number }>();
  graded.records.forEach((record, i) => {
    const bar = take.notes[i]?.measureIndex ?? -1;
    const entry = byBar.get(bar) ?? { notes: 0, counts: {}, firstQuarter: take.quarterIndex[i]?.quarter ?? 0 };
    entry.notes += 1;
    entry.counts[record.verdict] = (entry.counts[record.verdict] ?? 0) + 1;
    byBar.set(bar, entry);
  });
  const timeOf = (q: number): string => {
    for (const p of take.path) if (p.quarter >= q) return `${p.perfTimeSeconds.toFixed(1)}s`;
    return "never";
  };
  console.log("\nbar  reached  notes  in/close/out/unclear/not-played");
  for (const [bar, e] of [...byBar.entries()].sort((a, b) => a[0] - b[0])) {
    const c = e.counts;
    console.log(`${String(bar + 1).padStart(3)}  ${timeOf(e.firstQuarter).padStart(7)}  ${String(e.notes).padStart(5)}  ` +
      `${c.in_tune ?? 0}/${c.close ?? 0}/${c.out_of_tune ?? 0}/${c.unmeasured ?? 0}/${c.not_played ?? 0}`);
  }
}

void main();
