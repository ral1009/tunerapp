import type { NoteAccuracyRecord } from "./cursor";

export interface PracticeReviewSummary {
  unstableNoteIds: string[];
  averageCentsError: number;
}

// unstableNoteIds are NoteAccuracyRecord.stepIndex values (session-local, not ScoreDocument ids --
// persistence/cross-session note identity is out of scope for now).
export function summarizePracticeSession(history: NoteAccuracyRecord[]): PracticeReviewSummary {
  const played = history.filter((record) => record.verdict !== "not_played");
  const unstable = played.filter((record) => record.verdict === "out_of_tune");
  const averageCentsError =
    played.length === 0
      ? 0
      : played.reduce((sum, record) => sum + Math.abs(record.averageCentsOff ?? 0), 0) / played.length;

  return {
    unstableNoteIds: unstable.map((record) => String(record.stepIndex)),
    averageCentsError
  };
}
