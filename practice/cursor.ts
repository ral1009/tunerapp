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
}

export const DEFAULT_SCORE_FOLLOWER_CONFIG: ScoreFollowerConfig = {
  inTuneCentsThreshold: 15,
  onsetSettleMs: 40,
  minSamplesForVerdict: 2
};

function centsOff(frequencyHz: number, expectedFrequencyHz: number): number {
  return 1200 * Math.log2(frequencyHz / expectedFrequencyHz);
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
    return this.emit();
  }

  onLiveFrame(frame: LivePitchFrame): ScoreFollowerState {
    if (this.status !== "awaiting_first_onset" && this.status !== "in_progress") {
      return this.getState();
    }

    if (frame.onsetDetected) {
      if (this.status === "awaiting_first_onset") {
        this.status = "in_progress";
        this.beginTrackingCurrentNote(frame.timestampMs);
      } else {
        this.finalizeCurrentNote();
        const next = this.cursor.advanceToNextNote();
        if (next === null) {
          this.status = "completed";
          this.current = null;
          this.liveCentsOffFromExpected = null;
        } else {
          this.current = next;
          this.beginTrackingCurrentNote(frame.timestampMs);
        }
      }
      return this.emit();
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
