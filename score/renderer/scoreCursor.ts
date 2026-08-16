import { Pitch, type Cursor as OsmdCursor } from "opensheetmusicdisplay";

// OSMD stores Pitch.Octave internally offset from the MusicXML octave convention by a fixed
// constant (Pitch.OctaveXmlDifference, currently 3) -- e.g. MusicXML octave 4 (middle C's octave)
// is stored internally as 1. Pitch.Frequency/rendering are self-consistent using that internal
// number, so they're unaffected, but Pitch.ToStringShort() returns the *internal* octave unless
// explicitly told to correct it -- confirmed by testing: a score's middle C read back as "C1" here
// while rendering it correctly on the staff. Always pass the offset when formatting for display.
const OCTAVE_DISPLAY_OFFSET = Pitch.OctaveXmlDifference;

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
  // Look ahead to whatever advanceToNextNote() would land on, without actually moving the cursor
  // (walks forward then rewinds with the same step count via osmdCursor.previous()). Null at
  // end-of-score. For practice/cursor.ts to sanity-check a candidate onset's pitch against the
  // *upcoming* note before committing to an advance.
  peekNextNote(): CursorNoteInfo | null;
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
          pitchLabel: primary.Pitch.ToStringShort(OCTAVE_DISPLAY_OFFSET),
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
      const info = landOnNextNonRestNote();
      // osmdCursor.reset() repositions the iterator but doesn't reliably redraw the cursor
      // element when it landed on the first note without an intervening next() call (next() is
      // the only path that visibly moves the cursor) -- force a redraw so a restarted practice
      // session doesn't leave the cursor visually parked at wherever the previous session ended.
      osmdCursor.update();
      return info;
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
      const info = landOnNextNonRestNote();
      // Force a redraw rather than relying on next()'s own visual side effect -- peekNextNote()
      // below does its own next()/previous() round trips on every frame during a pending
      // transition (see practice/cursor.ts), and there's no guarantee those leave OSMD's cursor
      // element in a state where a subsequent next() here reliably redraws on its own. Same
      // fix as reset() above, same reasoning: never trust an implicit redraw for something the
      // player is watching in real time.
      osmdCursor.update();
      return info;
    },

    peekNextNote(): CursorNoteInfo | null {
      if (osmdCursor.Iterator.EndReached) {
        return null;
      }

      let steps = 0;
      osmdCursor.next();
      steps += 1;

      let peeked: CursorNoteInfo | null = null;
      while (!osmdCursor.Iterator.EndReached) {
        const notes = osmdCursor.NotesUnderCursor().filter((note) => !note.isRest());
        if (notes.length > 0) {
          const primary = notes[0];
          peeked = {
            stepIndex: stepIndex + 1,
            measureIndex: osmdCursor.Iterator.CurrentMeasureIndex,
            frequenciesHz: notes.map((note) => note.Pitch.Frequency),
            primaryFrequencyHz: primary.Pitch.Frequency,
            pitchLabel: primary.Pitch.ToStringShort(OCTAVE_DISPLAY_OFFSET),
            isRest: false
          };
          break;
        }
        osmdCursor.next();
        steps += 1;
      }

      for (let i = 0; i < steps; i += 1) {
        osmdCursor.previous();
      }

      // Restore the visual cursor to match the real (rewound) logical position immediately --
      // called on every frame during a pending transition (practice/cursor.ts), so any visual
      // drift from the next()/previous() round trip above must not be left to accumulate or
      // linger until the next real advanceToNextNote() call.
      osmdCursor.update();

      return peeked;
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
