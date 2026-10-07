import type { NoteAccuracyRecord, NoteVerdict } from "./cursor";

// How a finished take is graded. Followers store raw readings (cents from the written pitch at
// A440); the reference and the bands are applied here, at summary time, so switching between
// "my tuning" and A440 is instant and loses nothing.
//
// - "own" (default): cents are measured from the player's own reference pitch. A whole recording
//   tuned 20 cents flat isn't a mistake on every note -- it's an instrument tuned 20 cents flat,
//   and marking every note red teaches nothing. Replaying real recordings showed exactly that:
//   players sat 7-35 cents off A440 and nearly every note came back out of tune.
// - "a440": absolute, for a player who wants to check their reference pitch itself.
export type GradeReference = "own" | "a440";

export interface GradingOptions {
  reference: GradeReference;
  // |cents| <= inTuneCents: in tune. <= closeCents: close (worth a look, not a mistake).
  // Beyond: out of tune.
  inTuneCents: number;
  closeCents: number;
}

export const DEFAULT_GRADING: GradingOptions = { reference: "own", inTuneCents: 15, closeCents: 30 };

// Open strings, A440 equal temperament. A note written at one of these pitches is usually played
// as the open string, and the open strings are what the player tuned -- typically with a tuner.
const OPEN_STRING_HZ = [196.0, 293.66, 440.0, 659.26];
// Enough open-string readings to trust their median over the whole-take median.
const MIN_OPEN_STRING_NOTES = 3;

export interface GradedTake {
  records: NoteAccuracyRecord[];
  // Cents from A440 that grading was measured against (0 for "a440").
  referenceCents: number;
  // Where the reference came from. "open_strings" is preferred: the median of ALL notes would
  // absorb a player's systematic habit (every fingered note 20 cents flat moves the median flat
  // and hides the very thing they need to fix), while the open strings are set independently of
  // finger placement.
  referenceSource: "open_strings" | "all_notes" | "a440";
}

function isGraded(record: NoteAccuracyRecord): boolean {
  return record.averageCentsOff !== null && (record.verdict === "in_tune" || record.verdict === "out_of_tune" || record.verdict === "close");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function gradeTake(history: readonly NoteAccuracyRecord[], options: GradingOptions = DEFAULT_GRADING): GradedTake {
  const graded = history.filter(isGraded);
  let referenceCents = 0;
  let referenceSource: GradedTake["referenceSource"] = "a440";
  if (options.reference === "own" && graded.length > 0) {
    const openStrings = graded.filter((record) =>
      OPEN_STRING_HZ.some((hz) => Math.abs(1200 * Math.log2(record.expectedFrequencyHz / hz)) < 5)
    );
    if (openStrings.length >= MIN_OPEN_STRING_NOTES) {
      referenceCents = median(openStrings.map((record) => record.averageCentsOff as number));
      referenceSource = "open_strings";
    } else {
      referenceCents = median(graded.map((record) => record.averageCentsOff as number));
      referenceSource = "all_notes";
    }
  }
  const records = history.map((record) => {
    if (!isGraded(record)) return record;
    const cents = (record.averageCentsOff as number) - referenceCents;
    const magnitude = Math.abs(cents);
    const verdict: NoteVerdict = magnitude <= options.inTuneCents ? "in_tune" : magnitude <= options.closeCents ? "close" : "out_of_tune";
    return { ...record, averageCentsOff: cents, verdict };
  });
  return { records, referenceCents, referenceSource };
}

export interface PracticeReviewSummary {
  inTuneNoteIds: string[];
  // Between the in-tune and close thresholds: shown, but not counted as a mistake.
  closeNoteIds: string[];
  unstableNoteIds: string[];
  notPlayedNoteIds: string[];
  // Reached but not gradable (see NoteVerdict) -- neither counted as missed nor in the average.
  unmeasuredNoteIds: string[];
  averageCentsError: number;
  referenceCents: number;
  referenceSource: GradedTake["referenceSource"];
}

// Ids are NoteAccuracyRecord.stepIndex values (session-local, not ScoreDocument ids --
// persistence/cross-session note identity is out of scope for now).
export function summarizePracticeSession(
  history: NoteAccuracyRecord[],
  options: GradingOptions = DEFAULT_GRADING
): PracticeReviewSummary {
  const { records, referenceCents, referenceSource } = gradeTake(history, options);
  const ids = (verdict: NoteVerdict) => records.filter((record) => record.verdict === verdict).map((record) => String(record.stepIndex));
  // Only graded notes. Filtering on "not not_played" used to let an ungraded note with a null
  // averageCentsOff into the average as a perfect 0 cents.
  const played = records.filter(isGraded);
  const averageCentsError =
    played.length === 0 ? 0 : played.reduce((sum, record) => sum + Math.abs(record.averageCentsOff ?? 0), 0) / played.length;
  return {
    inTuneNoteIds: ids("in_tune"),
    closeNoteIds: ids("close"),
    unstableNoteIds: ids("out_of_tune"),
    notPlayedNoteIds: ids("not_played"),
    unmeasuredNoteIds: ids("unmeasured"),
    averageCentsError,
    referenceCents,
    referenceSource
  };
}
