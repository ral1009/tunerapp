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

// Duration (quarter-note units) of a rest at this cursor position, or 0 if this position isn't
// genuinely resting -- a tie/slur continuation is ALSO non-tickable, but isn't rest time, so this
// only counts an actual note.isRest() position.
function restDurationQuarterNotes(notes: readonly Note[]): number {
  const restNote = notes.find((note) => note.isRest());
  return restNote ? restNote.Length.RealValue * 4 : 0;
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
  // Notated duration in quarter-note units (e.g. 1.0 = quarter note, 0.5 = eighth, 2.0 = half) --
  // NOT real time, and not "beats" in the time-signature sense (a 6/8 beat is a dotted quarter,
  // not this unit). Matches score/schema.ts's ScoreNote.durationBeats convention (durationTicks /
  // divisions, i.e. also quarter-note units) for consistency between the two note
  // representations, even though this one is read directly off OSMD's Note.Length (a fraction of
  // a WHOLE note) rather than derived from MusicXML ticks. Used by ScoreFollower to convert a
  // tempo estimate (ms per quarter note) into an expected real-time duration for this note --
  // see ScoreFollowerConfig.adaptiveStabilityWindowEnabled.
  durationQuarterNotes: number;
  // Total quarter-note duration of any rest(s) immediately preceding this note (0 if none) --
  // ScoreCursor's forward walk silently skips over rest positions when finding the next tickable
  // note, same as it always has (the pitch/onset-driven ScoreFollower never needed rest timing --
  // a rest there just means no onset fires for a while, which its existing onset/implicit-drift
  // machinery already tolerates). MetronomeScoreFollower's strictly clock-driven advancement DOES
  // need this: without it, a rest's time was silently dropped from the schedule entirely, and the
  // cursor advanced straight through it as though it didn't exist -- racing ahead of real time for
  // the rest of the piece. Only accurate for the FORWARD walk (reset/advanceToNextNote/advanceBy/
  // peekNextNote/peekAhead) -- the backward walk (retreatToPreviousNote/retreatBy/peekBehind)
  // always reports 0 here, since nothing currently consuming those paths (ScoreFollower's resync)
  // needs rest timing, and the correct backward value is semantically the rest AFTER this note in
  // that direction, not before it -- attaching it here would be actively wrong, not just unused.
  precedingRestQuarterNotes: number;
}

export interface NoteHighlight {
  stepIndex: number;
  color: string;
}

export interface QuarterIndexEntry {
  // Quarter notes from the start of the score, read from OSMD's own iterator timestamp rather than
  // accumulated from note durations -- OSMD already tracks absolute position, and re-deriving it
  // by summing durations has to independently get rests, ties and pickup bars right.
  quarter: number;
  stepIndex: number;
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
  // (walks forward, then restores a saved copy of the cursor's position). Null at
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
  // Maps each landable note's absolute position in the score (in quarter notes from the start) to
  // its stepIndex, for callers that receive positions in musical time rather than note counts --
  // see practice/matchmakerFollower.ts. Walks the whole score once and leaves the cursor reset at
  // the front, so call it before a session starts, not during one.
  buildQuarterIndex(): QuarterIndexEntry[];
  // Moves to the landable note covering `quarter` (the last entry at or before it, so a position
  // inside a rest or a tied continuation holds on the note that's still sounding). Returns null
  // when the index is empty or the cursor can't reach the target.
  seekToQuarter(index: readonly QuarterIndexEntry[], quarter: number): CursorNoteInfo | null;
  // Every landable note in the score, in stepIndex order (so result[i].stepIndex === i). For
  // callers that need each note's expected pitch without walking the live cursor -- see
  // practice/offlineIntonationScorer.ts. Like buildQuarterIndex(), leaves the cursor reset at the
  // front, so call it before or after a session, not during one.
  listNotes(): CursorNoteInfo[];
  show(): void;
  hide(): void;
  setHighlightColor(cssColor: string): void;
  // Sets NoteheadColor on the underlying OSMD Note(s) at each given stepIndex and triggers a full
  // sheet redraw (via the redraw callback passed to createScoreCursor) so the change is visible --
  // NoteheadColor only takes effect on the next render, it isn't a live/cursor-position update
  // like the rest of this interface. For end-of-session review coloring (out-of-tune/not-played),
  // not for anything during live tracking. Walks the whole score from the front to locate each
  // stepIndex (same isTickable walk as the rest of this file), then resets the iterator back to
  // the front afterward -- doesn't touch or restore this cursor's own live position/stepIndex
  // counter, since by the time this is called practice has already ended and a later
  // ScoreFollower.start() calls reset() again before reusing this cursor anyway.
  highlightNotes(highlights: NoteHighlight[]): void;
}

export function createScoreCursor(getCursor: () => OsmdCursor, redraw: () => void): ScoreCursor {
  let stepIndex = -1;
  let currentInfo: CursorNoteInfo | null = null;
  // OSMD's render() (called by redraw(), e.g. from highlightNotes()) doesn't update the EXISTING
  // Cursor object -- it silently replaces osmd.cursor with a brand-new instance every time
  // (OpenSheetMusicDisplay.enableOrDisableCursors(), confirmed by reading the minified bundle:
  // `this.cursors[t]=new Cursor(...)`, called from render()). OSMD does correctly restore
  // hidden/iterator state onto that new instance (EngravingRules.RestoreCursorAfterRerender
  // defaults to true), so the new cursor itself is fine -- but any PREVIOUSLY captured reference
  // to the old Cursor object becomes silently inert: calling next()/show()/hide()/etc. on it no
  // longer affects anything actually on screen, since OSMD moved on to a different object. Every
  // method below re-fetches via getCursor() rather than closing over a single Cursor reference,
  // so a highlightNotes() redraw mid-session can't orphan the rest of this cursor's operations.
  let osmdCursor = getCursor();

  // Immediately after landing on a tickable note, walks forward temporarily to accumulate the
  // duration of any tie/same-pitch-slur continuation(s) that immediately follow it (and keeps
  // going in case of a longer chain -- half tied to quarter tied to eighth, ...) -- this is what
  // makes a tied note's DURATION reflect its full combined held length, not just the first note's
  // own notated length. isTickable() already treats a tie as one continuous landing position, but
  // without this the continuation's OWN duration was silently dropped from the schedule entirely
  // (confirmed live: a dotted-half tied to a dotted-quarter -- 9 eighth notes total -- was only
  // held for 6, exactly the dotted half's own length, with the tied dotted quarter's duration lost
  // outright). Must be called with the cursor positioned exactly at the just-landed note -- always
  // rewinds back to that same position before returning, since the real cursor position must
  // remain wherever the caller found the landing.
  // Look-ahead helpers walk the cursor and must leave it exactly where it was. They used to rewind
  // by calling osmdCursor.previous() once per step taken, but OSMD's previous() throws
  // ("Cannot read properties of undefined (reading 'StaffEntries')") when stepping back across an
  // empty measure -- which OMR output produces (a photo-imported score with a 0-beat bar crashed
  // every Matchmaker session at listNotes(), leaving the page on "Preparing score..." forever).
  // Restoring a clone of the iterator puts the cursor back without walking at all.
  function savePosition(): () => void {
    const saved = osmdCursor.iterator.clone();
    return () => {
      osmdCursor.iterator = saved.clone();
    };
  }

  function accumulateTiedContinuationQuarterNotes(): number {
    let extra = 0;
    const restore = savePosition();
    while (!osmdCursor.Iterator.EndReached) {
      osmdCursor.next();
      const notesHere = osmdCursor.NotesUnderCursor();
      const continuation = notesHere.find((note) => isTieContinuation(note) || isSlurredSamePitchContinuation(note));
      if (!continuation) {
        break;
      }
      extra += continuation.Length.RealValue * 4;
    }
    restore();
    return extra;
  }

  function landOnNextNonRestNote(): CursorNoteInfo | null {
    let precedingRestQuarterNotes = 0;
    while (!osmdCursor.Iterator.EndReached) {
      const allNotes = osmdCursor.NotesUnderCursor();
      const notes = allNotes.filter(isTickable);
      if (notes.length > 0) {
        stepIndex += 1;
        const primary = notes[0];
        currentInfo = {
          stepIndex,
          measureIndex: osmdCursor.Iterator.CurrentMeasureIndex,
          frequenciesHz: notes.map((note) => note.Pitch.Frequency),
          primaryFrequencyHz: primary.Pitch.Frequency,
          pitchLabel: primary.Pitch.ToStringShort(OCTAVE_DISPLAY_OFFSET),
          isRest: false,
          durationQuarterNotes: primary.Length.RealValue * 4 + accumulateTiedContinuationQuarterNotes(),
          precedingRestQuarterNotes
        };
        return currentInfo;
      }
      precedingRestQuarterNotes += restDurationQuarterNotes(allNotes);
      osmdCursor.next();
    }

    currentInfo = null;
    return null;
  }

  // Mirror of landOnNextNonRestNote() walking backward -- decrements stepIndex instead of
  // incrementing it, checks Iterator.FrontReached instead of EndReached. Always reports
  // precedingRestQuarterNotes: 0 -- see CursorNoteInfo.precedingRestQuarterNotes's doc comment
  // for why a backward walk can't correctly attribute rest time to the landed note.
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
          isRest: false,
          durationQuarterNotes: primary.Length.RealValue * 4 + accumulateTiedContinuationQuarterNotes(),
          precedingRestQuarterNotes: 0
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

  // Walks forward up to `count` non-rest notes without moving the real cursor position (restores
  // a saved copy of the position afterwards), tagging each landed-on note
  // with its 1-based forward offset from the current position.
  function peekAhead(count: number): Array<{ offset: number; note: CursorNoteInfo }> {
    const results: Array<{ offset: number; note: CursorNoteInfo }> = [];
    const restore = savePosition();
    let noteOffset = 0;
    let precedingRestQuarterNotes = 0;

    while (noteOffset < count && !osmdCursor.Iterator.EndReached) {
      osmdCursor.next();
      const allNotes = osmdCursor.NotesUnderCursor();
      const notes = allNotes.filter(isTickable);
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
            isRest: false,
            durationQuarterNotes: primary.Length.RealValue * 4 + accumulateTiedContinuationQuarterNotes(),
            precedingRestQuarterNotes
          }
        });
        precedingRestQuarterNotes = 0;
      } else {
        precedingRestQuarterNotes += restDurationQuarterNotes(allNotes);
      }
    }

    restore();

    return results;
  }

  // Mirror of peekAhead() walking backward -- returns notes tagged with negative offsets. Always
  // reports precedingRestQuarterNotes: 0 -- see CursorNoteInfo.precedingRestQuarterNotes's doc
  // comment.
  function peekBehind(count: number): Array<{ offset: number; note: CursorNoteInfo }> {
    const results: Array<{ offset: number; note: CursorNoteInfo }> = [];
    const restore = savePosition();
    let noteOffset = 0;

    while (noteOffset < count && !osmdCursor.Iterator.FrontReached) {
      osmdCursor.previous();
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
            isRest: false,
            durationQuarterNotes: primary.Length.RealValue * 4 + accumulateTiedContinuationQuarterNotes(),
            precedingRestQuarterNotes: 0
          }
        });
      }
    }

    restore();

    return results;
  }

  return {
    reset(): CursorNoteInfo | null {
      osmdCursor = getCursor();
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
      osmdCursor = getCursor();
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
      osmdCursor = getCursor();
      const info = advanceOneNote();
      if (info === null) {
        osmdCursor.hide();
      } else {
        osmdCursor.update();
      }
      return info;
    },

    peekNextNote(): CursorNoteInfo | null {
      osmdCursor = getCursor();
      if (osmdCursor.Iterator.EndReached) {
        return null;
      }

      const restore = savePosition();
      let precedingRestQuarterNotes = 0;
      osmdCursor.next();

      let peeked: CursorNoteInfo | null = null;
      while (!osmdCursor.Iterator.EndReached) {
        const allNotes = osmdCursor.NotesUnderCursor();
        const notes = allNotes.filter(isTickable);
        if (notes.length > 0) {
          const primary = notes[0];
          peeked = {
            stepIndex: stepIndex + 1,
            measureIndex: osmdCursor.Iterator.CurrentMeasureIndex,
            frequenciesHz: notes.map((note) => note.Pitch.Frequency),
            primaryFrequencyHz: primary.Pitch.Frequency,
            pitchLabel: primary.Pitch.ToStringShort(OCTAVE_DISPLAY_OFFSET),
            isRest: false,
            durationQuarterNotes: primary.Length.RealValue * 4 + accumulateTiedContinuationQuarterNotes(),
            precedingRestQuarterNotes
          };
          break;
        }
        precedingRestQuarterNotes += restDurationQuarterNotes(allNotes);
        osmdCursor.next();
      }

      restore();

      // Restore the visual cursor to match the real (rewound) logical position immediately --
      // called on every frame during a pending transition (practice/cursor.ts), so any visual
      // drift from the next()/previous() round trip above must not be left to accumulate or
      // linger until the next real advanceToNextNote() call.
      osmdCursor.update();

      return peeked;
    },

    retreatToPreviousNote(): CursorNoteInfo | null {
      osmdCursor = getCursor();
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
      osmdCursor = getCursor();
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
      osmdCursor = getCursor();
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

    buildQuarterIndex(): QuarterIndexEntry[] {
      osmdCursor = getCursor();
      osmdCursor.reset();

      const entries: QuarterIndexEntry[] = [];
      let walkStepIndex = -1;
      while (!osmdCursor.Iterator.EndReached) {
        // Same isTickable filter as every other walk in this file, so the stepIndex counted here
        // is the same one landOnNextNonRestNote() assigns -- a rest or tie continuation is not its
        // own landing position in either.
        if (osmdCursor.NotesUnderCursor().filter(isTickable).length > 0) {
          walkStepIndex += 1;
          entries.push({
            // RealValue is in whole notes; x4 converts to the quarter-note units used throughout
            // this codebase (CursorNoteInfo.durationQuarterNotes, ScoreNote.durationBeats).
            quarter: osmdCursor.Iterator.currentTimeStamp.RealValue * 4,
            stepIndex: walkStepIndex
          });
        }
        osmdCursor.next();
      }

      // Leave the cursor where a caller would expect to begin: back at the first note, with this
      // module's own stepIndex/currentInfo bookkeeping in agreement with it.
      stepIndex = -1;
      osmdCursor.reset();
      landOnNextNonRestNote();
      osmdCursor.update();
      return entries;
    },

    listNotes(): CursorNoteInfo[] {
      osmdCursor = getCursor();
      stepIndex = -1;
      osmdCursor.reset();

      // The same landing/advance helpers live tracking uses, so each entry carries exactly what
      // the live follower would have seen on that note -- including tied continuations folded
      // into durationQuarterNotes.
      const notes: CursorNoteInfo[] = [];
      let info = landOnNextNonRestNote();
      while (info) {
        notes.push(info);
        info = advanceOneNote();
      }

      stepIndex = -1;
      osmdCursor.reset();
      landOnNextNonRestNote();
      osmdCursor.update();
      return notes;
    },

    seekToQuarter(index: readonly QuarterIndexEntry[], quarter: number): CursorNoteInfo | null {
      if (index.length === 0) {
        return currentInfo;
      }

      let low = 0;
      let high = index.length - 1;
      let targetStepIndex = index[0].stepIndex;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (index[mid].quarter <= quarter) {
          targetStepIndex = index[mid].stepIndex;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      // Moves via advanceBy/retreatBy rather than driving the OSMD iterator directly: stepIndex and
      // currentInfo are this module's own bookkeeping, and stepping the iterator behind their back
      // desyncs them silently.
      const delta = targetStepIndex - stepIndex;
      if (delta > 0) {
        return this.advanceBy(delta);
      }
      if (delta < 0) {
        return this.retreatBy(-delta);
      }
      return currentInfo;
    },

    peekWindow(aheadCount: number, behindCount: number): Array<{ offset: number; note: CursorNoteInfo }> {
      osmdCursor = getCursor();
      const ahead = peekAhead(Math.max(0, aheadCount));
      const behind = peekBehind(Math.max(0, behindCount));
      // Same forced-redraw reasoning as peekNextNote() above -- this does its own next()/
      // previous() round trips on every frame during a pending transition.
      osmdCursor.update();
      return [...behind, ...ahead];
    },

    show(): void {
      osmdCursor = getCursor();
      osmdCursor.show();
    },

    hide(): void {
      osmdCursor = getCursor();
      osmdCursor.hide();
    },

    setHighlightColor(cssColor: string): void {
      osmdCursor = getCursor();
      osmdCursor.CursorOptions = { ...osmdCursor.CursorOptions, color: cssColor };
      osmdCursor.update();
    },

    highlightNotes(highlights: NoteHighlight[]): void {
      // Always walks and sets every tickable note's color, including to "" (OSMD's default/
      // unset color) for anything NOT in the highlights map -- NOT a no-op-unless-something-to-
      // color early return. Callers rely on this to clear a previous session's colors: passing []
      // resets every note back to default, and passing a fresh highlight set implicitly clears
      // whatever was set by an earlier call rather than layering on top of it.
      osmdCursor = getCursor();
      const colorByStepIndex = new Map(highlights.map((highlight) => [highlight.stepIndex, highlight.color]));

      osmdCursor.reset();
      let walkStepIndex = -1;
      while (!osmdCursor.Iterator.EndReached) {
        const notes = osmdCursor.NotesUnderCursor().filter(isTickable);
        if (notes.length > 0) {
          walkStepIndex += 1;
          const color = colorByStepIndex.get(walkStepIndex) ?? "";
          for (const note of notes) {
            note.NoteheadColor = color;
          }
        }
        osmdCursor.next();
      }
      osmdCursor.reset();
      redraw();
    }
  };
}
