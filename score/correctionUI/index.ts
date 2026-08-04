import type { ScoreDocument } from "../schema";

export interface CorrectionChange {
  noteId: string;
  pitch?: string;
  durationBeats?: number;
}

export function applyCorrection(score: ScoreDocument, changes: CorrectionChange[]): ScoreDocument {
  const notesById = new Map<string, CorrectionChange>(changes.map((change) => [change.noteId, change]));

  return {
    ...score,
    measures: score.measures.map((measure) => ({
      ...measure,
      notes: measure.notes.map((note) => {
        const change = notesById.get(note.id);
        if (!change) {
          return note;
        }
        return {
          ...note,
          pitch: change.pitch ?? note.pitch,
          durationBeats: change.durationBeats ?? note.durationBeats
        };
      })
    }))
  };
}