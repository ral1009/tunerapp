import type { CursorNoteInfo, ScoreCursor } from "../score/renderer/scoreCursor";
import type { LivePitchFrame } from "../audio/captureModule";
import { centsOff, median, createEmptyRecord, type NoteAccuracyRecord, type ScoreFollowerState } from "./cursor";

// Separate, deliberately simpler tracking mode from ScoreFollower (practice/cursor.ts). That
// follower decides WHEN to advance from detected pitch/onset content -- which is exactly the
// mechanism this mode exists to route around, per this session's finding that pitch-based
// following isn't working reliably live. Here, cursor advancement is driven ONLY by a
// user-chosen metronome tempo applied to each note's notated duration -- no onset detection, no
// pitch matching, no resync of any kind. The live pitch detector still runs and is compared
// against whatever note the clock currently says should be playing, purely for intonation
// feedback -- it never influences *when* the cursor moves. This trades the ability to tolerate a
// player who doesn't keep the notated tempo for a tracking mechanism that can never get lost.
//
// Produces the exact same ScoreFollowerState shape ScoreFollower does (reusing its centsOff/
// median/verdict helpers) so App.tsx's existing practice UI (current note, intonation readout,
// end-of-session summary/highlighting) works unmodified against either follower.
export interface MetronomeFollowerConfig {
  bpm: number;
  inTuneCentsThreshold: number;
  // Ignore pitch samples within this window right after a note's scheduled start -- mirrors
  // ScoreFollowerConfig.onsetSettleMs's reasoning (bowed-string attacks are commonly messy right
  // at the attack), but here it's gated by the clock instead of a detected onset, since this mode
  // never looks for one.
  onsetSettleMs: number;
  minSamplesForVerdict: number;
}

export const DEFAULT_METRONOME_FOLLOWER_CONFIG: Omit<MetronomeFollowerConfig, "bpm"> = {
  inTuneCentsThreshold: 15,
  onsetSettleMs: 40,
  minSamplesForVerdict: 2
};

export class MetronomeScoreFollower {
  private readonly cursor: ScoreCursor;
  private readonly config: MetronomeFollowerConfig;
  private readonly msPerQuarterNote: number;
  private status: ScoreFollowerState["status"] = "idle";
  private current: CursorNoteInfo | null = null;
  private liveCentsOffFromExpected: number | null = null;
  private lastPitchReason: LivePitchFrame["reason"] = null;
  private history: NoteAccuracyRecord[] = [];
  private activeRecord: NoteAccuracyRecord | null = null;
  // Real-time timestamp (same clock domain as LivePitchFrame.timestampMs) the current note's
  // scheduled window began. Null until the first live frame after start() establishes it --
  // deliberately not set from start() itself, since start() may run before capture is delivering
  // frames yet and would otherwise pick a t0 in a different clock domain than frame.timestampMs.
  private currentNoteStartedAtMs: number | null = null;
  private readonly listeners = new Set<(state: ScoreFollowerState) => void>();

  constructor(cursor: ScoreCursor, config: MetronomeFollowerConfig) {
    this.cursor = cursor;
    this.config = config;
    // Guard against a non-positive/NaN bpm reaching here from any future caller that skips
    // App.tsx's own clamping -- 60000/0 is Infinity (every note's window never elapses, the
    // cursor looks permanently stuck) and 60000/negative is a negative duration (the advance loop
    // below would never be true), both indistinguishable from "broken" rather than "slow" to a
    // live user. Falls back to a plain, unremarkable default rather than silently clamping to a
    // min/max bound a caller didn't ask for.
    const safeBpm = config.bpm > 0 && Number.isFinite(config.bpm) ? config.bpm : 90;
    this.msPerQuarterNote = 60000 / safeBpm;
  }

  start(): ScoreFollowerState {
    this.current = this.cursor.reset();
    this.status = this.current ? "in_progress" : "completed";
    this.liveCentsOffFromExpected = null;
    this.lastPitchReason = null;
    this.history = [];
    this.activeRecord = this.current ? createEmptyRecord(this.current) : null;
    // TEMPORARY diagnostic for live speed reports -- prints each note's notated duration and the
    // real-ms window it was actually scheduled for, straight from durationQuarterNotes/bpm. Remove
    // once "too slow even at max bpm" is confirmed to be either a real durationQuarterNotes bug or
    // just long notated note values (not a bug) and this mode is otherwise live-validated.
    if (this.current) {
      console.debug(
        `[metronome] note 0 (${this.current.pitchLabel ?? "?"}) durationQuarterNotes=${this.current.durationQuarterNotes} -> ${this.noteDurationMs(this.current).toFixed(0)}ms @ ${this.msPerQuarterNote.toFixed(1)}ms/quarter | wallClockMs=${performance.now().toFixed(0)}`
      );
    }
    this.currentNoteStartedAtMs = null;
    return this.emit();
  }

  onLiveFrame(frame: LivePitchFrame): ScoreFollowerState {
    if (this.status !== "in_progress") {
      return this.getState();
    }

    this.lastPitchReason = frame.reason;

    let startedAtMs = this.currentNoteStartedAtMs ?? frame.timestampMs;
    this.currentNoteStartedAtMs = startedAtMs;

    // Advance through every note whose scheduled window has already elapsed as of this frame --
    // a loop, not a single if, so a frame-delivery gap can never permanently strand the cursor
    // behind the clock on a run of very short notes.
    while (this.current && frame.timestampMs - startedAtMs >= this.noteDurationMs(this.current)) {
      const overrunMs = frame.timestampMs - startedAtMs - this.noteDurationMs(this.current);
      this.finalizeCurrentNote();
      const next = this.cursor.advanceToNextNote();
      if (next === null) {
        this.status = "completed";
        this.current = null;
        this.liveCentsOffFromExpected = null;
        this.currentNoteStartedAtMs = startedAtMs;
        return this.emit();
      }
      this.current = next;
      // See the matching TEMPORARY log in start() above.
      console.debug(
        `[metronome] note ${this.current.stepIndex} (${this.current.pitchLabel ?? "?"}) durationQuarterNotes=${this.current.durationQuarterNotes} -> ${this.noteDurationMs(this.current).toFixed(0)}ms @ ${this.msPerQuarterNote.toFixed(1)}ms/quarter | wallClockMs=${performance.now().toFixed(0)} frameTimestampMs=${frame.timestampMs.toFixed(0)}`
      );
      // Absorb the overrun into the new note's start time rather than resetting to frame.timestampMs
      // outright -- otherwise a slow frame-delivery gap would silently shrink every subsequent
      // note's sampling window by the same amount, compounding across the piece.
      startedAtMs = frame.timestampMs - overrunMs;
      this.currentNoteStartedAtMs = startedAtMs;
      this.liveCentsOffFromExpected = null;
      this.activeRecord = createEmptyRecord(this.current);
    }

    if (!this.current || frame.isSilent || frame.frequencyHz === null || this.current.primaryFrequencyHz === null) {
      return this.emit();
    }

    const cents = centsOff(frame.frequencyHz, this.current.primaryFrequencyHz);
    this.liveCentsOffFromExpected = cents;

    const elapsedInNoteMs = frame.timestampMs - startedAtMs;
    if (elapsedInNoteMs >= this.config.onsetSettleMs) {
      this.activeRecord?.centsOffSamples.push(cents);
    }

    return this.emit();
  }

  stop(): ScoreFollowerState {
    if (this.status === "in_progress") {
      this.finalizeCurrentNote();
      this.status = "stopped";
    }
    return this.emit();
  }

  getState(): ScoreFollowerState {
    return {
      status: this.status,
      current: this.current,
      liveCentsOffFromExpected: this.liveCentsOffFromExpected,
      history: this.history,
      lastPitchReason: this.lastPitchReason
    };
  }

  subscribe(listener: (state: ScoreFollowerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private noteDurationMs(note: CursorNoteInfo): number {
    return note.durationQuarterNotes * this.msPerQuarterNote;
  }

  private finalizeCurrentNote(): void {
    if (!this.activeRecord) {
      return;
    }

    const averageCentsOff = median(this.activeRecord.centsOffSamples);
    this.activeRecord.averageCentsOff = averageCentsOff;
    this.activeRecord.verdict =
      this.activeRecord.centsOffSamples.length < this.config.minSamplesForVerdict
        ? "not_played"
        : Math.abs(averageCentsOff ?? 0) <= this.config.inTuneCentsThreshold
          ? "in_tune"
          : "out_of_tune";

    this.history.push(this.activeRecord);
    this.activeRecord = null;
  }

  private emit(): ScoreFollowerState {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
    return state;
  }
}
