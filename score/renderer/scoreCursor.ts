import type { Cursor as OsmdCursor } from "opensheetmusicdisplay";

export interface CursorNoteInfo {
  // Monotonically increasing position counter for this render session only. NOT a ScoreDocument
  // note id, not stable across re-renders/sessions -- purely a same-session key for
  // practice/cursor.ts to accumulate per-note accuracy against.
  stepIndex: number;
  measureIndex: number;
  // All non-rest expected frequencies at this position (>1 only for chords/multi-voice).
  frequenciesHz: number[];
  // frequenciesHz[0], or null if this position is a rest. Violin is monophonic in practice --
  // per scope, chord/multi-voice positions collapse to the first non-rest note.
  primaryFrequencyHz: number | null;
  // Display-only label from OSMD's own Pitch.ToStringShort() (e.g. "A4"). Not guaranteed to
  // match the app's own pitchToNoteName format -- don't use for equality checks against
  // ScoreNote.pitch.
  pitchLabel: string | null;
  isRest: boolean;
}

export interface ScoreCursor {
  // Resets and positions the cursor at the first non-rest note (auto-skipping any leading
  // rests). Idempotent -- safe to call again to restart a practice session.
  reset(): CursorNoteInfo | null;
  isAtEnd(): boolean;
  // Info at the current position without moving. Null only before reset() or after the end.
  current(): CursorNoteInfo | null;
  // Advances one position and keeps auto-advancing through any rest positions until landing on
  // a non-rest note or the end. Returns the landed-on note, or null at end-of-score.
  advanceToNextNote(): CursorNoteInfo | null;
  show(): void;
  hide(): void;
  setHighlightColor(cssColor: string): void;
}

export function createScoreCursor(osmdCursor: OsmdCursor): ScoreCursor {
  let stepIndex = -1;
  let currentInfo: CursorNoteInfo | null = null;

  function landOnNextNonRestNote(): CursorNoteInfo | null {
    while (!osmdCursor.Iterator.EndReached) {
      const notes = osmdCursor.NotesUnderCursor().filter((note) => !note.isRest());
      if (notes.length > 0) {
        stepIndex += 1;
        const primary = notes[0];
        currentInfo = {
          stepIndex,
          measureIndex: osmdCursor.Iterator.CurrentMeasureIndex,
          frequenciesHz: notes.map((note) => note.Pitch.Frequency),
          primaryFrequencyHz: primary.Pitch.Frequency,
          pitchLabel: primary.Pitch.ToStringShort(),
          isRest: false
        };
        return currentInfo;
      }
      osmdCursor.next();
    }

    currentInfo = null;
    return null;
  }

  return {
    reset(): CursorNoteInfo | null {
      stepIndex = -1;
      osmdCursor.reset();
      return landOnNextNonRestNote();
    },

    isAtEnd(): boolean {
      return osmdCursor.Iterator.EndReached;
    },

    current(): CursorNoteInfo | null {
      return currentInfo;
    },

    advanceToNextNote(): CursorNoteInfo | null {
      if (osmdCursor.Iterator.EndReached) {
        currentInfo = null;
        return null;
      }
      osmdCursor.next();
      return landOnNextNonRestNote();
    },

    show(): void {
      osmdCursor.show();
    },

    hide(): void {
      osmdCursor.hide();
    },

    setHighlightColor(cssColor: string): void {
      osmdCursor.CursorOptions = { ...osmdCursor.CursorOptions, color: cssColor };
      osmdCursor.update();
    }
  };
}
