import { Pitch, type Cursor as OsmdCursor, type Note } from "opensheetmusicdisplay";

// OSMD stores Pitch.Octave internally offset from the MusicXML octave convention by a fixed
// constant (Pitch.OctaveXmlDifference, currently 3) -- e.g. MusicXML octave 4 (middle C's octave)
// is stored internally as 1. Pitch.Frequency/rendering are self-consistent using that internal
// number, so they're unaffected, but Pitch.ToStringShort() returns the *internal* octave unless
// explicitly told to correct it -- confirmed by testing: a score's middle C read back as "C1" here
// while rendering it correctly on the staff. Always pass the offset when formatting for display.
const OCTAVE_DISPLAY_OFFSET = Pitch.OctaveXmlDifference;

// A tied note (same pitch as the note before it, connected by <tie>) is sung/bowed as ONE
// continuous sound with no new attack at the tie point -- the player correctly does nothing
// there. Treating it as its own landing position (like any other note) meant ScoreFollower would
// wait forever for a fresh onset or pitch drift that a tie, by definition, never produces: no real
// onset fires (no re-articulation), and ImplicitOnsetWatcher's drift trigger never fires either
// (the pitch doesn't change at all across a tie). The cursor would silently get stuck on the
// tie's first note. Fix: skip tie-continuation notes when walking/peeking, exactly like rests
// already are -- the combined tied notes count as a single landing position, and cents-off
// tracking against that position naturally continues for the tie's full combined duration since
// nothing tells ScoreFollower to stop.
function isTieContinuation(note: Note): boolean {
  const tie = note.NoteTie;
  return tie != null && tie.StartNote !== note;
}

// A curved connector over two notes of the SAME pitch is functionally a tie regardless of which
// XML element actually encodes it -- some sources (hand-authored files, OMR output) mark this
// with <slur> instead of the technically-correct <tie>, and from the player's perspective it's
// identical either way: one continuous sound, no re-attack expected at the connection. This
// deliberately does NOT apply to a slur connecting notes of DIFFERENT pitches -- that's an
// ordinary legato phrase mark, and those notes genuinely need to be tracked as separate positions
// (the pitch really does change, just without a fresh bow attack -- that case is what
// ImplicitOnsetWatcher's drift detection is for, not this).
//
// Checked purely against the slur's own StartNote/pitch (not "the note immediately before this
// one") so it works the same regardless of which direction a caller is walking in -- correct for
// the common case of a simple two-note slur; a longer slur with an internal same-pitch repeat
// (not directly against the slur's start) is a narrower, rarer case not covered here.
function isSlurredSamePitchContinuation(note: Note): boolean {
  const slurs = note.NoteSlurs;
  if (!slurs) {
    return false;
  }
  return slurs.some((slur) => slur.StartNote !== note && slur.StartNote.Pitch.Frequency === note.Pitch.Frequency);
}

function isTickable(note: Note): boolean {
  return !note.isRest() && !isTieContinuation(note) && !isSlurredSamePitchContinuation(note);
}

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
  // Resets and positions the cursor at the first tickable note (auto-skipping any leading rests
  // or tie-continuation notes -- see isTickable()). Idempotent -- safe to call again to restart a
  // practice session.
  reset(): CursorNoteInfo | null;
  isAtEnd(): boolean;
  // Info at the current position without moving. Null only before reset() or after the end.
  current(): CursorNoteInfo | null;
  // Advances one position and keeps auto-advancing through any rest/tie-continuation positions
  // until landing on a tickable note or the end. Returns the landed-on note, or null at
  // end-of-score.
  advanceToNextNote(): CursorNoteInfo | null;
  // Look ahead to whatever advanceToNextNote() would land on, without actually moving the cursor
  // (walks forward then rewinds with the same step count via osmdCursor.previous()). Null at
  // end-of-score. For practice/cursor.ts to sanity-check a candidate onset's pitch against the
  // *upcoming* note before committing to an advance.
  peekNextNote(): CursorNoteInfo | null;
  // Mirror of advanceToNextNote() in reverse: moves one position back and keeps auto-retreating
  // through rest/tie-continuation positions until landing on a tickable note or the front of the
  // score. Null if already at the first tickable note (Iterator.FrontReached) or before reset().
  retreatToPreviousNote(): CursorNoteInfo | null;
  // Advance/retreat by exactly n tickable-note steps in one call, for committing a resync
  // decision. If end/front is reached partway through, stops early and returns whatever was
  // last landed on -- callers should treat a short-of-n landing as "clamp to what's there", not
  // an error.
  advanceBy(n: number): CursorNoteInfo | null;
  retreatBy(n: number): CursorNoteInfo | null;
  // Bidirectional generalization of peekNextNote(): looks ahead up to aheadCount and behind up
  // to behindCount tickable notes without moving the cursor (same walk-then-rewind technique).
  // An offset beyond the start/end of the score is simply omitted, not padded with null.
  peekWindow(aheadCount: number, behindCount: number): Array<{ offset: number; note: CursorNoteInfo }>;
  show(): void;
  hide(): void;
  setHighlightColor(cssColor: string): void;
}

export function createScoreCursor(osmdCursor: OsmdCursor): ScoreCursor {
  let stepIndex = -1;
  let currentInfo: CursorNoteInfo | null = null;

  function landOnNextNonRestNote(): CursorNoteInfo | null {
    while (!osmdCursor.Iterator.EndReached) {
      const notes = osmdCursor.NotesUnderCursor().filter(isTickable);
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

  // Mirror of landOnNextNonRestNote() walking backward -- decrements stepIndex instead of
  // incrementing it, checks Iterator.FrontReached instead of EndReached.
  function landOnPreviousNonRestNote(): CursorNoteInfo | null {
    while (!osmdCursor.Iterator.FrontReached) {
      const notes = osmdCursor.NotesUnderCursor().filter(isTickable);
      if (notes.length > 0) {
        stepIndex -= 1;
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
      osmdCursor.previous();
    }

    currentInfo = null;
    return null;
  }

  function advanceOneNote(): CursorNoteInfo | null {
    if (osmdCursor.Iterator.EndReached) {
      currentInfo = null;
      return null;
    }
    osmdCursor.next();
    return landOnNextNonRestNote();
  }

  function retreatOneNote(): CursorNoteInfo | null {
    if (osmdCursor.Iterator.FrontReached) {
      currentInfo = null;
      return null;
    }
    osmdCursor.previous();
    return landOnPreviousNonRestNote();
  }

  // Walks forward up to `count` non-rest notes without moving the real cursor position (rewinds
  // with the same number of previous() calls it took to get there), tagging each landed-on note
  // with its 1-based forward offset from the current position.
  function peekAhead(count: number): Array<{ offset: number; note: CursorNoteInfo }> {
    const results: Array<{ offset: number; note: CursorNoteInfo }> = [];
    let rawSteps = 0;
    let noteOffset = 0;

    while (noteOffset < count && !osmdCursor.Iterator.EndReached) {
      osmdCursor.next();
      rawSteps += 1;
      const notes = osmdCursor.NotesUnderCursor().filter(isTickable);
      if (notes.length > 0) {
        noteOffset += 1;
        const primary = notes[0];
        results.push({
          offset: noteOffset,
          note: {
            stepIndex: stepIndex + noteOffset,
            measureIndex: osmdCursor.Iterator.CurrentMeasureIndex,
            frequenciesHz: notes.map((note) => note.Pitch.Frequency),
            primaryFrequencyHz: primary.Pitch.Frequency,
            pitchLabel: primary.Pitch.ToStringShort(OCTAVE_DISPLAY_OFFSET),
            isRest: false
          }
        });
      }
    }

    for (let i = 0; i < rawSteps; i += 1) {
      osmdCursor.previous();
    }

    return results;
  }

  // Mirror of peekAhead() walking backward -- returns notes tagged with negative offsets.
  function peekBehind(count: number): Array<{ offset: number; note: CursorNoteInfo }> {
    const results: Array<{ offset: number; note: CursorNoteInfo }> = [];
    let rawSteps = 0;
    let noteOffset = 0;

    while (noteOffset < count && !osmdCursor.Iterator.FrontReached) {
      osmdCursor.previous();
      rawSteps += 1;
      const notes = osmdCursor.NotesUnderCursor().filter(isTickable);
      if (notes.length > 0) {
        noteOffset += 1;
        const primary = notes[0];
        results.push({
          offset: -noteOffset,
          note: {
            stepIndex: stepIndex - noteOffset,
            measureIndex: osmdCursor.Iterator.CurrentMeasureIndex,
            frequenciesHz: notes.map((note) => note.Pitch.Frequency),
            primaryFrequencyHz: primary.Pitch.Frequency,
            pitchLabel: primary.Pitch.ToStringShort(OCTAVE_DISPLAY_OFFSET),
            isRest: false
          }
        });
      }
    }

    for (let i = 0; i < rawSteps; i += 1) {
      osmdCursor.next();
    }

    return results;
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
      // Force a redraw rather than relying on next()'s own visual side effect -- peekNextNote()
      // below does its own next()/previous() round trips on every frame during a pending
      // transition (see practice/cursor.ts), and there's no guarantee those leave OSMD's cursor
      // element in a state where a subsequent next() here reliably redraws on its own. Same
      // fix as reset() above, same reasoning: never trust an implicit redraw for something the
      // player is watching in real time.
      //
      // At true end-of-score, advanceOneNote()'s internal search (landOnNextNonRestNote) has
      // already walked the REAL cursor forward via next() while hunting for a note that doesn't
      // exist, landing at/near the final barline before discovering there's nothing left --
      // update() would faithfully redraw the visual cursor there. Hide it instead of drawing a
      // stale, wrong position; a later reset()/show() (restarting practice) un-hides it.
      const info = advanceOneNote();
      if (info === null) {
        osmdCursor.hide();
      } else {
        osmdCursor.update();
      }
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
        const notes = osmdCursor.NotesUnderCursor().filter(isTickable);
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

    retreatToPreviousNote(): CursorNoteInfo | null {
      const info = retreatOneNote();
      // Same forced-redraw/hide-at-the-edge reasoning as advanceToNextNote() above.
      if (info === null) {
        osmdCursor.hide();
      } else {
        osmdCursor.update();
      }
      return info;
    },

    advanceBy(n: number): CursorNoteInfo | null {
      // Preserve the last successfully-landed note if a step fails PARTWAY through (e.g. n
      // overshoots the remaining score) -- a caller clamping an overshot resync target should land
      // on the last real note, not silently jump to "completed". But if the VERY FIRST step fails
      // (we were already at the true end before this call), there is no successful step to clamp
      // to -- must return null, matching advanceToNextNote()'s "reached the true end" semantics,
      // or the caller never observes a null landing and the piece never marks itself completed
      // (previously caused the OSMD cursor to visually drift to the final barline -- the internal
      // note search had already moved the real cursor forward looking for a note that doesn't
      // exist -- while the caller's own bookkeeping incorrectly still reported the old last note
      // as "current").
      let lastValid: CursorNoteInfo | null = null;
      let stepsCompleted = 0;
      for (let i = 0; i < n; i += 1) {
        const next = advanceOneNote();
        if (next === null) {
          break;
        }
        lastValid = next;
        stepsCompleted += 1;
      }
      currentInfo = stepsCompleted > 0 ? lastValid : null;
      // If NO step succeeded at all (genuinely nothing left, not a partial overshoot), the failed
      // internal search has already dragged the real cursor forward past the last note while
      // hunting for one that doesn't exist -- update() would faithfully redraw it there (at/near
      // the final barline) instead of showing nothing. Hide it; a later reset()/show() un-hides.
      if (currentInfo === null) {
        osmdCursor.hide();
      } else {
        osmdCursor.update();
      }
      return currentInfo;
    },

    retreatBy(n: number): CursorNoteInfo | null {
      // Mirror of advanceBy()'s clamp-to-last-valid and hide-at-the-edge reasoning above.
      let lastValid: CursorNoteInfo | null = null;
      let stepsCompleted = 0;
      for (let i = 0; i < n; i += 1) {
        const prev = retreatOneNote();
        if (prev === null) {
          break;
        }
        lastValid = prev;
        stepsCompleted += 1;
      }
      currentInfo = stepsCompleted > 0 ? lastValid : null;
      if (currentInfo === null) {
        osmdCursor.hide();
      } else {
        osmdCursor.update();
      }
      return currentInfo;
    },

    peekWindow(aheadCount: number, behindCount: number): Array<{ offset: number; note: CursorNoteInfo }> {
      const ahead = peekAhead(Math.max(0, aheadCount));
      const behind = peekBehind(Math.max(0, behindCount));
      // Same forced-redraw reasoning as peekNextNote() above -- this does its own next()/
      // previous() round trips on every frame during a pending transition.
      osmdCursor.update();
      return [...behind, ...ahead];
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
