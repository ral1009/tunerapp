import type { CursorNoteInfo, QuarterIndexEntry, ScoreCursor } from "../score/renderer/scoreCursor";
import type { LivePitchFrame } from "../audio/captureModule";
import {
  centsOff,
  median,
  createEmptyRecord,
  isPlausibleReading,
  type NoteAccuracyRecord,
  type ScoreFollowerState
} from "./cursor";

// Third tracking mode, alongside ScoreFollower (practice/cursor.ts, pitch/onset-driven) and
// MetronomeScoreFollower (practice/metronomeFollower.ts, clock-driven). Here the "where are we in
// the score" decision is made by Matchmaker -- a published real-time score-following library
// running online time warping over chroma features in the Python server (server/matchmaker_service.py)
// -- and arrives as absolute quarter-note positions over a WebSocket (audio/matchmakerStream.ts).
//
// This follower owns neither the audio nor the alignment: it maps incoming positions onto the OSMD
// cursor and does the intonation half itself, scoring live pitch frames against whatever note the
// alignment says is current. That split is the whole point -- position tracking was the part this
// app could never make reliable by hand, while the cents measurement built around PitchDetector
// already works.
//
// Emits the same ScoreFollowerState shape as the other two followers so App.tsx's practice UI and
// practice/reviewSummary.ts work against it unmodified.
export interface MatchmakerFollowerConfig {
  inTuneCentsThreshold: number;
  // Ignore pitch samples for this long after landing on a note -- same reasoning as the other two
  // followers: bowed attacks are messy right at the start, and a position jump lands mid-attack
  // more often than not.
  onsetSettleMs: number;
  minSamplesForVerdict: number;
  // See cursor.ts's isPlausibleReading() -- identical rule and defaults, so a low-confidence,
  // wildly-off reading can't produce a false "out_of_tune" on a note nobody played.
  plausibilityHighConfidenceThreshold: number;
  plausibilityLowConfidenceCentsLimit: number;
  plausibilityAbsoluteCentsLimit: number;
  // How many consecutive updates must agree on the same target note before the cursor actually
  // moves. Online time warping's output jitters by a frame or two around a transition; without
  // this the cursor visibly flickers between adjacent notes even while tracking correctly. Costs
  // one or two update intervals (~33ms each at Matchmaker's 30fps) of added latency.
  positionStabilityCount: number;
}

export const DEFAULT_MATCHMAKER_FOLLOWER_CONFIG: MatchmakerFollowerConfig = {
  inTuneCentsThreshold: 15,
  onsetSettleMs: 40,
  minSamplesForVerdict: 2,
  plausibilityHighConfidenceThreshold: 0.8,
  plausibilityLowConfidenceCentsLimit: 250,
  plausibilityAbsoluteCentsLimit: 1000,
  positionStabilityCount: 2
};

export interface MatchmakerTraceEntry {
  atMs: number;
  quarter: number;
  fromStepIndex: number;
  toStepIndex: number;
}

const TRACE_BUFFER_SIZE = 200;

export class MatchmakerScoreFollower {
  private readonly cursor: ScoreCursor;
  private readonly config: MatchmakerFollowerConfig;
  private status: ScoreFollowerState["status"] = "idle";
  private current: CursorNoteInfo | null = null;
  private liveCentsOffFromExpected: number | null = null;
  private lastPitchReason: LivePitchFrame["reason"] = null;
  // Keyed by stepIndex rather than appended to a list: alignment can revisit a note (the player
  // repeats a bar, or OLTW corrects an earlier overshoot backwards), and a revisit should keep
  // adding to that note's own record instead of creating a duplicate entry for it.
  private records = new Map<number, NoteAccuracyRecord>();
  private quarterIndex: QuarterIndexEntry[] = [];
  private currentNoteStartedAtMs = 0;
  private pendingStepIndex: number | null = null;
  private pendingCount = 0;
  private lastQuarter: number | null = null;
  private trace: MatchmakerTraceEntry[] = [];
  private pendingFinalStatus: "completed" | "stopped" | null = null;
  private scoringSource: "offline" | "live" | null = null;
  private readonly listeners = new Set<(state: ScoreFollowerState) => void>();

  constructor(cursor: ScoreCursor, config: MatchmakerFollowerConfig = DEFAULT_MATCHMAKER_FOLLOWER_CONFIG) {
    this.cursor = cursor;
    this.config = config;
  }

  start(): ScoreFollowerState {
    // Built before anything else: this walks the whole score and leaves the cursor back at the
    // first note, so it must not run once positions are already arriving.
    this.quarterIndex = this.cursor.buildQuarterIndex();
    this.current = this.cursor.reset();
    this.status = this.current ? "in_progress" : "completed";
    this.liveCentsOffFromExpected = null;
    this.lastPitchReason = null;
    this.records = new Map();
    this.pendingFinalStatus = null;
    this.scoringSource = null;
    this.trace = [];
    this.pendingStepIndex = null;
    this.pendingCount = 0;
    this.lastQuarter = null;
    this.currentNoteStartedAtMs = performance.now();
    if (this.current) {
      this.records.set(this.current.stepIndex, createEmptyRecord(this.current));
    }
    return this.emit();
  }

  // Called for each alignment update (audio/matchmakerStream.ts's onPosition), in quarter notes
  // from the start of the score. Already converted from Matchmaker's own time-signature-relative
  // beat units server-side -- see server/matchmaker_service.py's convert_beat_to_quarter.
  onQuarterPosition(quarter: number): ScoreFollowerState {
    if (this.status !== "in_progress") {
      return this.getState();
    }

    this.lastQuarter = quarter;
    const target = this.targetStepIndexFor(quarter);
    if (target === null || target === this.current?.stepIndex) {
      this.pendingStepIndex = null;
      this.pendingCount = 0;
      return this.getState();
    }

    if (target !== this.pendingStepIndex) {
      this.pendingStepIndex = target;
      this.pendingCount = 1;
      return this.getState();
    }

    this.pendingCount += 1;
    if (this.pendingCount < this.config.positionStabilityCount) {
      return this.getState();
    }

    this.pendingStepIndex = null;
    this.pendingCount = 0;
    this.moveTo(target, quarter);
    return this.emit();
  }

  // Intonation sampling only -- this never moves the cursor. Identical in substance to
  // MetronomeScoreFollower.onLiveFrame minus the click mask (no metronome runs in this mode).
  onLiveFrame(frame: LivePitchFrame): ScoreFollowerState {
    if (this.status !== "in_progress" || !this.current) {
      return this.getState();
    }

    this.lastPitchReason = frame.reason;

    if (
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
      this.records.get(this.current.stepIndex)?.centsOffSamples.push(cents);
    }

    return this.emit();
  }

  // Called when the alignment service reports the run finished (the score ran out, or the stream
  // ended). Distinct from stop(): this is the piece completing, not the user quitting. Both wait
  // in "scoring" for the post-practice intonation pass rather than ending outright -- see
  // applyOfflineHistory()/finalizeWithoutOffline().
  complete(): ScoreFollowerState {
    this.enterScoring("completed");
    return this.emit();
  }

  stop(): ScoreFollowerState {
    this.enterScoring("stopped");
    return this.emit();
  }

  // Replaces the live-rough per-note history with the post-practice one and ends the session.
  // A full replace, not a merge: offline samples are assigned to notes by a global alignment of
  // the whole take, strictly better-informed than live samples assigned to wherever a jittery
  // live cursor happened to be. Ignored once the session has already ended (e.g. the result
  // arrived after the timeout fallback already showed the summary).
  applyOfflineHistory(records: readonly NoteAccuracyRecord[]): ScoreFollowerState {
    if (this.status !== "scoring" && this.status !== "in_progress") {
      return this.getState();
    }
    this.records = new Map(records.map((record) => [record.stepIndex, { ...record }]));
    this.scoringSource = "offline";
    this.finish();
    return this.emit();
  }

  // Ends the session on the live-rough history -- the fallback when the post-practice pass never
  // arrives (timeout, server error, connection dropped) or the session was abandoned outright.
  finalizeWithoutOffline(): ScoreFollowerState {
    if (this.status !== "scoring" && this.status !== "in_progress") {
      return this.getState();
    }
    this.scoringSource = "live";
    this.finish();
    return this.emit();
  }

  // Which history the final summary was built from: "offline" (post-practice alignment) or
  // "live" (approximate fallback). Null while the session is still running.
  getScoringSource(): "offline" | "live" | null {
    return this.scoringSource;
  }

  private enterScoring(finalStatus: "completed" | "stopped"): void {
    if (this.status !== "in_progress") {
      return;
    }
    this.status = "scoring";
    this.pendingFinalStatus = finalStatus;
    this.current = null;
    this.liveCentsOffFromExpected = null;
  }

  private finish(): void {
    this.status = this.pendingFinalStatus ?? "completed";
    this.current = null;
    this.liveCentsOffFromExpected = null;
  }

  getState(): ScoreFollowerState {
    return {
      status: this.status,
      current: this.current,
      liveCentsOffFromExpected: this.liveCentsOffFromExpected,
      history: this.buildHistory(),
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

  // Exposed on window.__scoreFollower alongside the other followers -- live sessions in this
  // project have repeatedly behaved differently than any offline check predicted, and a trace of
  // what the cursor actually did is what makes that diagnosable rather than guesswork.
  getTrace(): readonly MatchmakerTraceEntry[] {
    return this.trace;
  }

  getDiagnostics(): {
    status: ScoreFollowerState["status"];
    lastQuarter: number | null;
    stepIndex: number | null;
    indexedNotes: number;
  } {
    return {
      status: this.status,
      lastQuarter: this.lastQuarter,
      stepIndex: this.current?.stepIndex ?? null,
      indexedNotes: this.quarterIndex.length
    };
  }

  private targetStepIndexFor(quarter: number): number | null {
    if (this.quarterIndex.length === 0) {
      return null;
    }
    let low = 0;
    let high = this.quarterIndex.length - 1;
    let found = this.quarterIndex[0].stepIndex;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.quarterIndex[mid].quarter <= quarter) {
        found = this.quarterIndex[mid].stepIndex;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  private moveTo(targetStepIndex: number, quarter: number): void {
    const fromStepIndex = this.current?.stepIndex ?? -1;

    // Notes jumped over were never sounded (or at least never tracked through), so give each one an
    // empty record: the review summary reports those as "not played", which is the honest answer.
    // Only forward jumps create these -- moving backwards revisits notes that already have records.
    for (let step = fromStepIndex + 1; step < targetStepIndex; step += 1) {
      if (!this.records.has(step)) {
        this.records.set(step, this.placeholderRecord(step));
      }
    }

    const landed = this.cursor.seekToQuarter(this.quarterIndex, quarter);
    this.trace.push({
      atMs: performance.now(),
      quarter,
      fromStepIndex,
      toStepIndex: landed?.stepIndex ?? -1
    });
    if (this.trace.length > TRACE_BUFFER_SIZE) {
      this.trace.shift();
    }

    if (landed === null) {
      this.enterScoring("completed");
      return;
    }

    this.current = landed;
    this.liveCentsOffFromExpected = null;
    this.currentNoteStartedAtMs = performance.now();
    if (!this.records.has(landed.stepIndex)) {
      this.records.set(landed.stepIndex, createEmptyRecord(landed));
    }
  }

  // A note the cursor skipped past: its CursorNoteInfo was never landed on, so the index is all we
  // have. Only stepIndex and the verdict matter to reviewSummary.ts; the rest stays null/empty so
  // it can't be mistaken for a real measurement.
  private placeholderRecord(stepIndex: number): NoteAccuracyRecord {
    return {
      stepIndex,
      measureIndex: -1,
      pitchLabel: null,
      // 0 matches createEmptyRecord()'s own convention for "no usable expected pitch"; nothing
      // reads it on a not_played record.
      expectedFrequencyHz: 0,
      centsOffSamples: [],
      averageCentsOff: null,
      verdict: "not_played",
      inferredFromRepeat: false
    };
  }

  // Verdicts are recomputed from samples on every read rather than frozen when a note is left --
  // idempotent, and it means a revisited note's verdict reflects all of its samples, not just the
  // ones collected before the first time the cursor moved away.
  //
  // Except after applyOfflineHistory(): those verdicts come from the post-take scorer and are
  // final. Recomputing them here applied the LIVE rule (minSamplesForVerdict samples) to the
  // score-informed method's single whole-span measurement per note, and turned every graded note
  // -- and every "unmeasured" one -- into "not_played". Found in the first full live-loop run
  // (headless Chrome, a recording as the microphone): tracking reached all 42 notes, the summary
  // said 42 not played.
  private buildHistory(): NoteAccuracyRecord[] {
    const history = [...this.records.values()].sort((a, b) => a.stepIndex - b.stepIndex);
    if (this.scoringSource === "offline") {
      return history;
    }
    for (const record of history) {
      const averageCentsOff = median(record.centsOffSamples);
      record.averageCentsOff = averageCentsOff;
      record.verdict =
        record.centsOffSamples.length < this.config.minSamplesForVerdict
          ? "not_played"
          : Math.abs(averageCentsOff ?? 0) <= this.config.inTuneCentsThreshold
            ? "in_tune"
            : "out_of_tune";
    }
    return history;
  }

  private emit(): ScoreFollowerState {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
    return state;
  }
}
