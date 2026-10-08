// Offline checks for practice/spotPractice.ts (same convention as the other harnesses: no test
// framework, run with `npm run spotPracticeTest`).
import type { CursorNoteInfo, QuarterIndexEntry } from "../../score/renderer/scoreCursor";
import { createEmptyRecord, type NoteAccuracyRecord, type NoteVerdict } from "../cursor";
import { DEFAULT_GRADING } from "../reviewSummary";
import { historyInRegion, passIsOver, resolveSpotRegion, summarizePass, type SpotRegion } from "../spotPractice";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) passed += 1;
  else failed += 1;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`);
}

// Four bars of 4/4 quarter notes, except bar 3 is empty (an OMR misread).
const notes: CursorNoteInfo[] = [];
const quarterIndex: QuarterIndexEntry[] = [];
for (const [bar, count] of [[0, 4], [1, 4], [3, 4], [4, 2]] as const) {
  for (let k = 0; k < count; k += 1) {
    const stepIndex = notes.length;
    notes.push({ stepIndex, measureIndex: bar, frequenciesHz: [440], primaryFrequencyHz: 440, pitchLabel: "A4", isRest: false, durationQuarterNotes: 1, precedingRestQuarterNotes: 0 });
    quarterIndex.push({ quarter: bar * 4 + k, stepIndex });
  }
}

console.log("1. resolving bars to notes");
{
  const region = resolveSpotRegion(notes, quarterIndex, 2, 4) as SpotRegion;
  check("bars 2-4 cover notes 4-11", typeof region === "object" && region.firstStepIndex === 4 && region.lastStepIndex === 11);
  check("starts at bar 2's first note", typeof region === "object" && region.fromQuarter === 4);
  const reversed = resolveSpotRegion(notes, quarterIndex, 4, 2) as SpotRegion;
  check("bars typed in reverse are swapped", typeof reversed === "object" && reversed.fromBar === 2 && reversed.toBar === 4);
  check("an empty bar alone is an error", typeof resolveSpotRegion(notes, quarterIndex, 3, 3) === "string");
  check("a bar past the end is an error", typeof resolveSpotRegion(notes, quarterIndex, 9, 10) === "string");
  check("missing numbers are an error", typeof resolveSpotRegion(notes, quarterIndex, Number.NaN, 2) === "string");
}

console.log("\n2. grading only the loop");
{
  const region = resolveSpotRegion(notes, quarterIndex, 2, 2) as SpotRegion;
  const record = (step: number, verdict: NoteVerdict, cents: number | null): NoteAccuracyRecord => ({
    ...createEmptyRecord(notes[step]),
    verdict,
    averageCentsOff: cents,
    centsOffSamples: cents === null ? [] : [cents]
  });
  // Notes 0-3 were jumped over (not played); bar 2 played; note 8 is past the loop.
  const history = [
    ...[0, 1, 2, 3].map((step) => record(step, "not_played", null)),
    record(4, "in_tune", 3),
    record(5, "out_of_tune", -40),
    record(6, "in_tune", 20),
    record(8, "in_tune", 0)
  ];
  check("history is cut to the loop", historyInRegion(history, region).map((r) => r.stepIndex).join(",") === "4,5,6");
  const pass = summarizePass(1, history, region, DEFAULT_GRADING);
  check(
    "pass counts: 1 in tune, 1 close, 1 out, 1 never reached",
    pass.inTune === 1 && pass.close === 1 && pass.outOfTune === 1 && pass.notPlayed === 1 && pass.notes === 4,
    JSON.stringify(pass)
  );
}

console.log("\n3. when a pass is over");
{
  const region = resolveSpotRegion(notes, quarterIndex, 1, 2) as SpotRegion;
  check("inside the loop: not over", !passIsOver(5, region, false));
  check("paused mid-loop: not over", !passIsOver(5, region, true));
  check("on the last note, still playing: not over", !passIsOver(7, region, false));
  check("on the last note, stopped: over", passIsOver(7, region, true));
  check("past the loop: over", passIsOver(8, region, false));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
