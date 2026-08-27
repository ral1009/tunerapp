import type { CursorNoteInfo, ScoreCursor } from "../score/renderer/scoreCursor";
import type { LivePitchFrame } from "../audio/captureModule";
import {
  centsOff,
  median,
  createEmptyRecord,
  isPlausibleReading,
  semitoneDistance,
  type NoteAccuracyRecord,
  type ScoreFollowerState
} from "./cursor";

// Separate, deliberately simpler tracking mode from ScoreFollower (practice/cursor.ts). That
// follower decides WHEN to advance from detected pitch/onset content -- which is exactly the
// mechanism this mode exists to route around, per this session's finding that pitch-based
// following isn't working reliably live. Here, cursor advancement is driven by advanceOnTick(),
// called externally by practice/metronome.ts's BeatClock -- the SAME scheduled event that
// produces the audible click, not an independent approximation of it (see BeatClockOptions.onTick's
// doc comment for the two-clock-domain problem this replaced). The live pitch detector still runs
// and is compared against whatever note the clock currently says should be playing, for intonation
// feedback and (optionally -- see bowAttackDetectionEnabled below) to nudge exactly when a
// boundary is crossed.
//
// Produces the exact same ScoreFollowerState shape ScoreFollower does (reusing its centsOff/
// median/verdict helpers) so App.tsx's existing practice UI (current note, intonation readout,
// end-of-session summary/highlighting) works unmodified against either follower.
export interface MetronomeFollowerConfig {
  inTuneCentsThreshold: number;
  // Ignore pitch samples within this window right after a note's scheduled start -- mirrors
  // ScoreFollowerConfig.onsetSettleMs's reasoning (bowed-string attacks are commonly messy right
  // at the attack), but here it's gated by the clock instead of a detected onset, since this mode
  // never looks for one. Measured against performance.now() (see currentNoteStartedAtMs), not any
  // frame/audio timestamp -- this follower no longer has a tempo of its own to convert between
  // units, so wall-clock time is the only clock it needs for this.
  onsetSettleMs: number;
  minSamplesForVerdict: number;
  // See cursor.ts's isPlausibleReading() -- same rule, same defaults, applied here identically so
  // a low-confidence, wildly-off reading (background noise/silence artifacts that still cleared
  // the base pitch detector's own confidence floor) can't produce a false "out_of_tune" verdict on
  // a note nobody actually played.
  plausibilityHighConfidenceThreshold: number;
  plausibilityLowConfidenceCentsLimit: number;
  // Hard ceiling in cents, no confidence exception -- see cursor.ts's
  // ScoreFollowerConfig.plausibilityAbsoluteCentsLimit doc comment. Confirmed live: even after
  // clickMaskMs, the metronome's own click (a clean tone the detector reads confidently) was
  // still producing false "out_of_tune" verdicts -- this is the unconditional backstop for
  // whatever gets past both the mask and the confidence-scaled check above.
  plausibilityAbsoluteCentsLimit: number;
  // Off by default: the cursor advances strictly on the beat clock's own schedule, with zero
  // regard for detected pitch/onsets -- this is what guarantees the audible click and the visible
  // cursor can never disagree about timing (see advanceOnTick()'s doc comment). Turning this on
  // trades away some of that guarantee: a real bow attack (LivePitchFrame.onsetDetected) whose
  // resulting pitch clearly matches the UPCOMING note, landing within
  // bowAttackToleranceQuarterNotes of the current note's scheduled end (on EITHER side -- early or
  // late), is trusted to advance the cursor right then instead of waiting for the tick schedule.
  // This directly targets the boundary mis-scoring problem (a late player's tail bleeding into the
  // new note's score, or an early player's head bleeding into the old one) at the cost of
  // reintroducing a small, bounded amount of clock/attack disagreement -- an explicit trade the
  // user makes by turning this on, not a silent default.
  bowAttackDetectionEnabled: boolean;
  // How far (in quarter-notes, on EITHER side of the current note's scheduled end) a confirmed
  // bow attack is trusted to shift the cutover -- bounded the same way the old boundary-refinement
  // design was bounded in real time, just expressed in the tick clock's own units now. Only
  // consulted when bowAttackDetectionEnabled is true.
  bowAttackToleranceQuarterNotes: number;
  // How close (in semitones) a detected pitch must sit to the UPCOMING note's expected frequency
  // to count as a confirmed attack -- same purpose as ScoreFollowerConfig.pitchMatchToleranceSemitones.
  bowAttackPitchMatchToleranceSemitones: number;
  // How long (real ms) to mask out incoming pitch samples after notifyClickPlayed() -- see that
  // method's doc comment. Covers the click's own ~70ms of audio (CLICK_DURATION_SECONDS plus its
  // stop-offset tail in practice/metronome.ts) plus room reverb/mic latency; "informed but not
  // certain," not derived from anything rigorous.
  clickMaskMs: number;
}

export const DEFAULT_METRONOME_FOLLOWER_CONFIG: MetronomeFollowerConfig = {
  inTuneCentsThreshold: 15,
  onsetSettleMs: 40,
  minSamplesForVerdict: 2,
  plausibilityHighConfidenceThreshold: 0.8,
  plausibilityLowConfidenceCentsLimit: 250,
  plausibilityAbsoluteCentsLimit: 1000,
  bowAttackDetectionEnabled: false,
  bowAttackToleranceQuarterNotes: 0.5,
  bowAttackPitchMatchToleranceSemitones: 3,
  // Bumped from 150ms: confirmed live that 150ms wasn't enough headroom (room reverb/mic
  // proximity to the speaker can extend how long the click is actually audible to the mic beyond
  // its own ~70ms of scheduled audio) -- 250ms trades a slightly later resume of real sampling
  // after each click for actually covering the tail in practice.
  clickMaskMs: 250
};

// Floating-point safety margin for the accumulated-quarter-notes comparison in advanceOnTick --
// FINE_SUBDIVISIONS_PER_QUARTER's fractions (quarters, e.g. 0.25) sum exactly in IEEE754 on their
// own, but durationQuarterNotes values arrive from OSMD's own Length.RealValue computation
// (score/renderer/scoreCursor.ts), which is not guaranteed to land on a perfectly exact float.
const ACCUMULATION_EPSILON = 1e-6;

export class MetronomeScoreFollower {
  private readonly cursor: ScoreCursor;
  private readonly config: MetronomeFollowerConfig;
  private status: ScoreFollowerState["status"] = "idle";
  private current: CursorNoteInfo | null = null;
  private liveCentsOffFromExpected: number | null = null;
  private lastPitchReason: LivePitchFrame["reason"] = null;
  private history: NoteAccuracyRecord[] = [];
  private activeRecord: NoteAccuracyRecord | null = null;
  // Real wall-clock (performance.now()) instant the current note became current -- used only to
  // gate onsetSettleMs in onLiveFrame. Deliberately performance.now(), not a frame/audio
  // timestamp: advanceOnTick() is called by the beat clock, which has no LivePitchFrame to read a
  // timestamp from, so a universal clock available to both call sites is what keeps this simple.
  private currentNoteStartedAtMs = 0;
  private accumulatedQuarterNotes = 0;
  // Real wall-clock instant until which incoming pitch samples should be ignored, set by
  // notifyClickPlayed(). 0 (i.e. always in the past) until the first click actually plays.
  private clickMaskedUntilMs = 0;
  private readonly listeners = new Set<(state: ScoreFollowerState) => void>();

  constructor(cursor: ScoreCursor, config: MetronomeFollowerConfig) {
    this.cursor = cursor;
    this.config = config;
  }

  start(): ScoreFollowerState {
    this.current = this.cursor.reset();
    this.status = this.current ? "in_progress" : "completed";
    this.liveCentsOffFromExpected = null;
    this.lastPitchReason = null;
    this.history = [];
    this.activeRecord = this.current ? createEmptyRecord(this.current) : null;
    this.accumulatedQuarterNotes = 0;
    this.currentNoteStartedAtMs = performance.now();
    return this.emit();
  }

  // Called directly by practice/metronome.ts's BeatClock on every tick -- the PRIMARY thing that
  // decides when the cursor moves. `quarterNotesElapsed` accumulates against the current note's
  // own durationQuarterNotes; once enough ticks have accumulated, advance (a loop, not a single
  // if, so a note shorter than one tick's worth of time can't strand the cursor behind by more
  // than one tick). When bowAttackDetectionEnabled is on, a confirmed attack (see checkBowAttack())
  // may have already advanced past this note via onLiveFrame before a tick even gets here --
  // isDueToAdvance() only fires the bounded grace-expiry fallback in that case, never double-commits.
  advanceOnTick(quarterNotesElapsed: number): ScoreFollowerState {
    if (this.status !== "in_progress" || !this.current) {
      return this.getState();
    }

    this.accumulatedQuarterNotes += quarterNotesElapsed;

    while (this.current && this.isDueToAdvance()) {
      this.commitAdvance();
    }

    return this.emit();
  }

  // Called by practice/metronome.ts's BeatClock at the real-time instant an audible click starts
  // playing (BeatClockOptions.onClick). The click plays through the same speakers the microphone
  // can pick up, and a clean sine-wave click reads to the pitch detector as a confidently-detected
  // tone -- there is no way to distinguish "our own click" from "a real note" in the signal itself
  // without knowing WHEN it was scheduled, which is exactly what this call provides. Confirmed
  // live: the click was triggering false "out_of_tune" readings even after the plausibility filter
  // (isPlausibleReading), since a clean tone clears the high-confidence bar that filter trusts
  // unconditionally.
  notifyClickPlayed(): void {
    this.clickMaskedUntilMs = performance.now() + this.config.clickMaskMs;
  }

  // Pitch sampling, plus (when enabled) bow-attack-triggered boundary correction.
  onLiveFrame(frame: LivePitchFrame): ScoreFollowerState {
    if (this.status !== "in_progress" || !this.current) {
      return this.getState();
    }

    this.lastPitchReason = frame.reason;

    const clickMasked = performance.now() < this.clickMaskedUntilMs;

    if (this.config.bowAttackDetectionEnabled && !clickMasked) {
      this.checkBowAttack(frame);
      if (!this.current) {
        // checkBowAttack() committed the last note of the piece -- nothing left to sample.
        return this.emit();
      }
    }

    if (
      clickMasked ||
      frame.isSilent ||
      frame.frequencyHz === null ||
      this.current.primaryFrequencyHz === null ||
      !isPlausibleReading(
        frame.frequencyHz,
        frame.confidence,
        this.current.primaryFrequencyHz,
        this.config.plausibilityHighConfidenceThreshold,
        this.config.plausibilityLowConfidenceCentsLimit,
        this.config.plausibilityAbsoluteCentsLimit
      )
    ) {
      return this.emit();
    }

    const cents = centsOff(frame.frequencyHz, this.current.primaryFrequencyHz);
    this.liveCentsOffFromExpected = cents;

    if (performance.now() - this.currentNoteStartedAtMs >= this.config.onsetSettleMs) {
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

  // `note`'s own notated duration PLUS any rest that immediately follows it (before the next real
  // note) -- ScoreCursor's walk otherwise silently skips rest positions entirely (see
  // CursorNoteInfo.precedingRestQuarterNotes's doc comment), which meant a rest's time was being
  // dropped from the schedule outright: the cursor advanced straight through it as though it
  // didn't exist, racing ahead of real time for the rest of the piece. The rest has no note of its
  // own to display, so it's folded into how long the PRECEDING note stays current instead.
  private effectiveDurationQuarterNotes(note: CursorNoteInfo): number {
    const upcoming = this.cursor.peekNextNote();
    return note.durationQuarterNotes + (upcoming?.precedingRestQuarterNotes ?? 0);
  }

  // True once the current note's accumulated tick time has reached its notated duration (plus any
  // following rest -- see effectiveDurationQuarterNotes()) AND (when bowAttackDetectionEnabled) the
  // bounded grace period has also run out -- this is the rigid, tick-driven fallback path only. A
  // bow-attack-confirmed transition (checkBowAttack()) commits immediately from onLiveFrame
  // instead, without ever going through this check.
  private isDueToAdvance(): boolean {
    if (!this.current) {
      return false;
    }
    const overshoot = this.accumulatedQuarterNotes - this.effectiveDurationQuarterNotes(this.current);
    if (overshoot < 0) {
      return false;
    }
    if (!this.config.bowAttackDetectionEnabled) {
      return true;
    }
    return overshoot >= this.config.bowAttackToleranceQuarterNotes;
  }

  // Only called when bowAttackDetectionEnabled. A real bow attack (onsetDetected) whose pitch is
  // clearly closer to the UPCOMING note than to the current one, landing within
  // bowAttackToleranceQuarterNotes of the current note's scheduled end (on either side), commits
  // the transition immediately -- whether that's EARLY (accumulated hasn't reached duration yet)
  // or LATE (already past duration, would otherwise still be waiting out the grace period in
  // isDueToAdvance()). Both cases are handled by the same distance check; only the sign of
  // `remaining` differs between them.
  private checkBowAttack(frame: LivePitchFrame): void {
    if (!this.current || !frame.onsetDetected || frame.isSilent || frame.frequencyHz === null) {
      return;
    }
    const upcoming = this.cursor.peekNextNote();
    if (!upcoming || upcoming.primaryFrequencyHz === null) {
      return;
    }
    const distanceToUpcoming = semitoneDistance(frame.frequencyHz, upcoming.primaryFrequencyHz);
    if (distanceToUpcoming > this.config.bowAttackPitchMatchToleranceSemitones) {
      return;
    }
    const distanceToCurrent =
      this.current.primaryFrequencyHz !== null ? semitoneDistance(frame.frequencyHz, this.current.primaryFrequencyHz) : Infinity;
    if (distanceToCurrent <= distanceToUpcoming) {
      // Not clearly closer to the upcoming note than to the current one -- for two adjacent notes
      // a semitone or two apart (ordinary stepwise motion), an absolute tolerance alone can't tell
      // "still on the outgoing note" from "already on the incoming one," so this comparative check
      // is what actually resolves it (same fix as this mode's earlier boundary-refinement attempt
      // needed, now reused here).
      return;
    }
    const remaining = this.effectiveDurationQuarterNotes(this.current) - this.accumulatedQuarterNotes;
    if (remaining > this.config.bowAttackToleranceQuarterNotes) {
      // Too early relative to the current note's own schedule to trust a jump yet.
      return;
    }
    this.commitAdvance();
  }

  // Single shared commit path for both the tick-driven (isDueToAdvance) and bow-attack-confirmed
  // (checkBowAttack) advance triggers, so both stay consistent about what "starting a new note"
  // resets.
  private commitAdvance(): void {
    const duration = this.current ? this.effectiveDurationQuarterNotes(this.current) : 0;
    this.accumulatedQuarterNotes = Math.max(0, this.accumulatedQuarterNotes - duration);
    this.finalizeCurrentNote();
    const next = this.cursor.advanceToNextNote();
    this.currentNoteStartedAtMs = performance.now();
    if (next === null) {
      this.status = "completed";
      this.current = null;
      this.liveCentsOffFromExpected = null;
      return;
    }
    this.current = next;
    this.liveCentsOffFromExpected = null;
    this.activeRecord = createEmptyRecord(next);
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
