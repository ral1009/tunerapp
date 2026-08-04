export interface PracticeReviewSummary {
  unstableNoteIds: string[];
  averageCentsError: number;
}

export function summarizePracticeSessions(): PracticeReviewSummary {
  return {
    unstableNoteIds: [],
    averageCentsError: 0
  };
}