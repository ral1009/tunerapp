import type { CursorNoteInfo, QuarterIndexEntry } from "../score/renderer/scoreCursor";
import type { NoteAccuracyRecord } from "./cursor";
import { summarizePracticeSession, type GradingOptions } from "./reviewSummary";

// Spot practice: loop a few bars, one graded pass at a time. Pure helpers so the region logic is
// testable without a browser (practice/__tests__/spot-practice-harness.ts); App.tsx does the
// wiring -- each pass is an ordinary Matchmaker take that starts with a jump to the region's first
// note (the same seek "Jump to bar" uses, so the post-take alignment starts there too) and ends
// when the player goes past the region or stops on its last note.

export interface SpotPracticeRange {
  startMeasureIndex: number;
  endMeasureIndex: number;
}

export function normalizeSpotPracticeRange(range: SpotPracticeRange): SpotPracticeRange {
  if (range.startMeasureIndex <= range.endMeasureIndex) {
    return range;
  }

  return {
    startMeasureIndex: range.endMeasureIndex,
    endMeasureIndex: range.startMeasureIndex
  };
}

export interface SpotRegion {
  // 1-based bar numbers as typed (after normalizing), same numbering as "Jump to bar".
  fromBar: number;
  toBar: number;
  firstStepIndex: number;
  lastStepIndex: number;
  // Where the region's first note sits, for the seek.
  fromQuarter: number;
}

// The notes in bars fromBar..toBar (either order). An error message instead when the bars don't
// exist or hold no notes.
export function resolveSpotRegion(
  notes: readonly CursorNoteInfo[],
  quarterIndex: readonly QuarterIndexEntry[],
  fromBar: number,
  toBar: number
): SpotRegion | string {
  if (!Number.isFinite(fromBar) || !Number.isFinite(toBar)) {
    return "Enter the first and last bar to loop.";
  }
  const range = normalizeSpotPracticeRange({ startMeasureIndex: fromBar - 1, endMeasureIndex: toBar - 1 });
  const inRange = notes.filter((note) => note.measureIndex >= range.startMeasureIndex && note.measureIndex <= range.endMeasureIndex);
  if (inRange.length === 0) {
    const lastBar = notes.length > 0 ? notes[notes.length - 1].measureIndex + 1 : 0;
    return range.startMeasureIndex + 1 > lastBar
      ? `This score has ${lastBar} bars.`
      : `Bars ${range.startMeasureIndex + 1}–${range.endMeasureIndex + 1} have no notes.`;
  }
  const firstStepIndex = Math.min(...inRange.map((note) => note.stepIndex));
  const lastStepIndex = Math.max(...inRange.map((note) => note.stepIndex));
  const entry = quarterIndex.find((candidate) => candidate.stepIndex === firstStepIndex);
  if (!entry) {
    return "Couldn't find where that bar starts in the score.";
  }
  return {
    fromBar: range.startMeasureIndex + 1,
    toBar: range.endMeasureIndex + 1,
    firstStepIndex,
    lastStepIndex,
    fromQuarter: entry.quarter
  };
}

// Only the region's notes: the jump to the region marks every note before it "not played", and a
// pass that ran on a little past the end shouldn't grade notes outside the loop either.
export function historyInRegion(history: readonly NoteAccuracyRecord[], region: SpotRegion | null): NoteAccuracyRecord[] {
  if (!region) return [...history];
  return history.filter((record) => record.stepIndex >= region.firstStepIndex && record.stepIndex <= region.lastStepIndex);
}

export interface SpotPassResult {
  pass: number;
  notes: number;
  inTune: number;
  close: number;
  outOfTune: number;
  unclear: number;
  notPlayed: number;
  averageCentsError: number;
}

export function summarizePass(
  pass: number,
  history: readonly NoteAccuracyRecord[],
  region: SpotRegion,
  options: GradingOptions
): SpotPassResult {
  const inRegion = historyInRegion(history, region);
  // Notes the alignment never reached have no record at all; count them as not played.
  const regionSize = region.lastStepIndex - region.firstStepIndex + 1;
  const summary = summarizePracticeSession(inRegion, options);
  return {
    pass,
    notes: regionSize,
    inTune: summary.inTuneNoteIds.length,
    close: summary.closeNoteIds.length,
    outOfTune: summary.unstableNoteIds.length,
    unclear: summary.unmeasuredNoteIds.length,
    notPlayed: regionSize - summary.inTuneNoteIds.length - summary.closeNoteIds.length - summary.unstableNoteIds.length - summary.unmeasuredNoteIds.length,
    averageCentsError: summary.averageCentsError
  };
}

// Has this pass reached its end? Past the region's last note, or on it with the player stopped.
export function passIsOver(currentStepIndex: number | null, region: SpotRegion, playerPaused: boolean): boolean {
  if (currentStepIndex === null) return false;
  if (currentStepIndex > region.lastStepIndex) return true;
  return currentStepIndex === region.lastStepIndex && playerPaused;
}
