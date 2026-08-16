import type { CursorNoteInfo, ScoreCursor } from "../score/renderer/scoreCursor";
import type { LivePitchFrame } from "../audio/captureModule";

export type NoteVerdict = "in_tune" | "out_of_tune" | "not_played";

export interface NoteAccuracyRecord {
  stepIndex: number;
  measureIndex: number;
  pitchLabel: string | null;
  expectedFrequencyHz: number;
  centsOffSamples: number[];
  // Median of centsOffSamples; null if empty.
  averageCentsOff: number | null;
  verdict: NoteVerdict;
}

export type ScoreFollowerStatus = "idle" | "awaiting_first_onset" | "in_progress" | "completed" | "stopped";

export interface ScoreFollowerState {
  status: ScoreFollowerStatus;
  current: CursorNoteInfo | null;
  // Cents-off of the most recent usable pitch frame vs. current's expected frequency (NOT vs.
  // the nearest chromatic pitch -- distinct from LiveCaptureState.centsOff, which can read
  // misleadingly "in tune" if the player is confidently on a wrong note). Null when there's no
  // current note or no usable pitch sample yet for it. Safe for live UI display.
  liveCentsOffFromExpected: number | null;
  history: NoteAccuracyRecord[];
}

export interface ScoreFollowerConfig {
  inTuneCentsThreshold: number;
  // Ignore pitch samples within this window right after an onset -- bowed-string attacks are
  // commonly messy/scratchy before the string settles.
  onsetSettleMs: number;
  minSamplesForVerdict: number;
  // An onset only advances the cursor if a detected pitch within this many semitones of the note
  // it would land on (current note for the very first onset, otherwise the peeked next note) shows
  // up within pendingTransitionWindowMs of the onset. Guards against non-violin transients (voice,
  // coughing, bow noise) being confidently pitched and onset-detected -- without this,
  // captureModule's onset gate only requires *some* detected pitch, not one that's actually
  // plausible for the piece being played.
  pitchMatchToleranceSemitones: number;
  // How long to keep checking incoming frames against the target pitch after an onset fires,
  // before giving up and waiting for another onset. Must not be a single-frame check against only
  // the onset-flagged instant -- bowed-string attacks are commonly messy/scratchy right at the
  // attack (same reason onsetSettleMs exists for cents tracking), so the *onset* frame's own pitch
  // reading routinely misses a plausible match even on completely correct playing. A too-short
  // window silently strands the cursor on the current note with no retry until some later,
  // unrelated onset-like blip happens to land inside tolerance -- this is what made fast passages
  // require playing unnaturally slowly, and made "just sustain the note" the only reliable way to
  // get an advance to register.
  pendingTransitionWindowMs: number;
}

export const DEFAULT_SCORE_FOLLOWER_CONFIG: ScoreFollowerConfig = {
  inTuneCentsThreshold: 15,
  onsetSettleMs: 40,
  minSamplesForVerdict: 2,
  pitchMatchToleranceSemitones: 3,
  pendingTransitionWindowMs: 150
};

interface PendingTransition {
  kind: "start" | "advance";
  deadlineMs: number;
}

function centsOff(frequencyHz: number, expectedFrequencyHz: number): number {
  return 1200 * Math.log2(frequencyHz / expectedFrequencyHz);
}

function semitoneDistance(frequencyAHz: number, frequencyBHz: number): number {
  return Math.abs(12 * Math.log2(frequencyAHz / frequencyBHz));
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function createEmptyRecord(note: CursorNoteInfo): NoteAccuracyRecord {
  return {
    stepIndex: note.stepIndex,
    measureIndex: note.measureIndex,
    pitchLabel: note.pitchLabel,
    expectedFrequencyHz: note.primaryFrequencyHz ?? 0,
    centsOffSamples: [],
    averageCentsOff: null,
    verdict: "not_played"
  };
}

export class ScoreFollower {
  private readonly cursor: ScoreCursor;
  private readonly config: ScoreFollowerConfig;
  private status: ScoreFollowerStatus = "idle";
  private current: CursorNoteInfo | null = null;
  private liveCentsOffFromExpected: number | null = null;
  private history: NoteAccuracyRecord[] = [];
  private activeRecord: NoteAccuracyRecord | null = null;
  private currentNoteStartedAtMs = 0;
  private pendingTransition: PendingTransition | null = null;
  private readonly listeners = new Set<(state: ScoreFollowerState) => void>();

  constructor(cursor: ScoreCursor, config?: Partial<ScoreFollowerConfig>) {
    this.cursor = cursor;
    this.config = { ...DEFAULT_SCORE_FOLLOWER_CONFIG, ...config };
  }

  start(): ScoreFollowerState {
    this.current = this.cursor.reset();
    this.status = this.current ? "awaiting_first_onset" : "completed";
    this.liveCentsOffFromExpected = null;
    this.history = [];
    this.activeRecord = null;
    this.pendingTransition = null;
    return this.emit();
  }

  onLiveFrame(frame: LivePitchFrame): ScoreFollowerState {
    if (this.status !== "awaiting_first_onset" && this.status !== "in_progress") {
      return this.getState();
    }

    // Belt-and-suspenders against captureModule's own onset gating: a transition should never
    // start on a frame the rest of the UI is treating as silence, regardless of what upstream
    // onset detection reported.
    if (frame.onsetDetected && !frame.isSilent) {
      if (this.pendingTransition) {
        // A fresh attack landed while still settling the previous one -- give it a new window
        // rather than letting the original deadline strand it.
        this.pendingTransition.deadlineMs = frame.timestampMs + this.config.pendingTransitionWindowMs;
      } else {
        this.pendingTransition = {
          kind: this.status === "awaiting_first_onset" ? "start" : "advance",
          deadlineMs: frame.timestampMs + this.config.pendingTransitionWindowMs
        };
      }
    }

    if (this.pendingTransition) {
      if (frame.isSilent) {
        return this.getState();
      }

      const targetFrequencyHz =
        this.pendingTransition.kind === "start"
          ? this.current?.primaryFrequencyHz ?? null
          : this.cursor.peekNextNote()?.primaryFrequencyHz ?? null;

      if (this.matchesExpectedPitch(frame.frequencyHz, targetFrequencyHz)) {
        this.commitPendingTransition(frame.timestampMs);
        return this.emit();
      }

      if (frame.timestampMs > this.pendingTransition.deadlineMs) {
        this.pendingTransition = null;
      }

      return this.getState();
    }

    if (
      this.status === "in_progress" &&
      this.current !== null &&
      this.current.primaryFrequencyHz !== null &&
      frame.frequencyHz !== null &&
      !frame.isSilent
    ) {
      const cents = centsOff(frame.frequencyHz, this.current.primaryFrequencyHz);
      this.liveCentsOffFromExpected = cents;

      if (frame.timestampMs - this.currentNoteStartedAtMs >= this.config.onsetSettleMs) {
        this.activeRecord?.centsOffSamples.push(cents);
      }

      return this.emit();
    }

    return this.getState();
  }

  private commitPendingTransition(timestampMs: number): void {
    const kind = this.pendingTransition?.kind;
    this.pendingTransition = null;

    if (kind === "start") {
      this.status = "in_progress";
      this.beginTrackingCurrentNote(timestampMs);
      return;
    }

    this.finalizeCurrentNote();
    const advanced = this.cursor.advanceToNextNote();
    if (advanced === null) {
      this.status = "completed";
      this.current = null;
      this.liveCentsOffFromExpected = null;
    } else {
      this.current = advanced;
      this.beginTrackingCurrentNote(timestampMs);
    }
  }

  stop(): ScoreFollowerState {
    if (this.status === "in_progress") {
      this.finalizeCurrentNote();
    }
    if (this.status === "awaiting_first_onset" || this.status === "in_progress") {
      this.status = "stopped";
    }
    return this.emit();
  }

  getState(): ScoreFollowerState {
    return {
      status: this.status,
      current: this.current,
      liveCentsOffFromExpected: this.liveCentsOffFromExpected,
      history: this.history
    };
  }

  subscribe(listener: (state: ScoreFollowerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  // expectedFrequencyHz is null when there's nothing to validate against (e.g. peekNextNote()
  // found no upcoming note because we're on the score's final note) -- nothing to reject there,
  // so let the transition through.
  private matchesExpectedPitch(detectedFrequencyHz: number | null, expectedFrequencyHz: number | null): boolean {
    if (expectedFrequencyHz === null) {
      return true;
    }
    if (detectedFrequencyHz === null) {
      return false;
    }
    return semitoneDistance(detectedFrequencyHz, expectedFrequencyHz) <= this.config.pitchMatchToleranceSemitones;
  }

  private beginTrackingCurrentNote(startedAtMs: number): void {
    this.currentNoteStartedAtMs = startedAtMs;
    this.liveCentsOffFromExpected = null;
    this.activeRecord = this.current ? createEmptyRecord(this.current) : null;
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
