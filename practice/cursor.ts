import type { CursorNoteInfo, ScoreCursor } from "../score/renderer/scoreCursor";
import type { LivePitchFrame } from "../audio/captureModule";
import { ImplicitOnsetWatcher } from "./implicitOnsetWatcher";

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
  // Resync candidate-start-offset bounds (in notes, not counting offset 0 or +1, which are
  // handled by their own dedicated paths) to search when the immediate-next-note match fails on
  // a frame. Forward recovers a missed note; backward recovers an extra/duplicate note (e.g. an
  // accidental re-articulation).
  resyncWindowAhead: number;
  resyncWindowBehind: number;
  // Minimum time since a pending "advance" transition's onset before its pitch reading is trusted
  // for any same-onset decision beyond the fast path -- both the offset-0 (same-note re-attack)
  // check AND recording a reading into the resync sequence buffer (below) wait for this. This is
  // the fix for a previously reverted regression: checking offset-0 too early (before this settle
  // delay) let a transiently stale pitch reading right after a genuine onset resolve as "no-op,
  // stay put", consuming the only onset a single bow stroke produces and stranding the cursor --
  // see the resolution order in resolveAdvancePendingTransition() for the full explanation.
  attackSettleMs: number;
  // Resync recovers from a missed/extra note by matching a SEQUENCE of recently-played pitches
  // against the score, not a single pitch -- a single played note is often ambiguous (e.g. a
  // repeated pitch appears more than once nearby), and committing off one note alone means
  // landing on a stale, already-passed position while the player has already moved on to the
  // next note, so the cursor perpetually lags one note behind trying to catch up. Each settled
  // onset's pitch extends a buffer (see extendResyncSequence()); resync only commits once the
  // matched sequence is unique, or once the buffer reaches this length and the closest remaining
  // candidate is used as a tie-break. Commit offset lands on the LAST note of the matched
  // sequence (what the player just finished playing), not one past it -- so the player's next
  // onset lines up with the ordinary fast path immediately, instead of still catching up.
  resyncMaxSequenceLength: number;
  // Ring-buffer size for getTrace()'s resync decision log.
  resyncTraceBufferSize: number;
  // Kill switch for the implicit-onset drift trigger (below), independent of the ordinary
  // onsetDetected trigger -- flip to false to instantly revert to onset-only behavior without a
  // code change, for fast live A/B comparison.
  implicitOnsetEnabled: boolean;
  // OnsetDetector (spectral-flux based) can miss a note change entirely on a legato/slurred bow
  // change, since there's no attack transient for flux to catch -- this silently breaks both
  // ordinary advancement (that note's transition never opens) and sequence resync (a missed note
  // leaves a gap in outOfSyncSequence, so it no longer represents temporally-consecutive score
  // notes and the contiguous match in findSequenceMatches() can't find it). ImplicitOnsetWatcher
  // (practice/implicitOnsetWatcher.ts) is a second, independent trigger: a sustained pitch change
  // away from current's expected frequency, held for at least implicitOnsetMinStableMs with no
  // real onset ever firing, is trusted as an implicit note change. Must exceed a full violin
  // vibrato cycle (~125-200ms at 5-8Hz) -- a shorter window risks catching a momentary still point
  // mid-vibrato-swing and false-triggering on the currently-held note. Set at the conservative
  // (longer) end of that range; tune down toward 150ms only if live testing shows no false
  // positives and the extra latency is actually felt.
  implicitOnsetMinStableMs: number;
  // How far (in semitones) a reading must sit from current's expected frequency before it counts
  // as "drifted away" at all -- gates whether ImplicitOnsetWatcher starts accumulating a candidate
  // run in the first place. This is a genuinely ambiguous number, not just an under-tuned one:
  // distinguishing "heavy vibrato on the SAME note" from "a real half-step legato transition" is
  // inherently ambiguous from pitch alone when their magnitudes overlap, since expressive/wide
  // ("heavy") violin vibrato can swing close to a semitone off-center -- confirmed live: heavy
  // vibrato on a held note was misread as an advance to the next note at the previous, tighter
  // default (0.6). Biased toward the safer failure mode per this session's established
  // preference (a missed legato transition just falls back to the real onset/resync paths and
  // degrades gracefully; a false-positive mid-note jump is actively wrong and misleading) -- set
  // high enough to clear plausible heavy-vibrato depth with real margin, which means clean
  // half-step legato transitions will generally NOT be caught by this path anymore and depend on
  // OnsetDetector or eventual resync instead. Lower this only with live evidence that false
  // vibrato triggers have stopped at the current value with room to spare.
  implicitOnsetStabilityToleranceSemitones: number;
  // How far a reading may sit from the RUNNING CENTROID of the candidate run (not from current,
  // and not from every other reading in the run) before it's treated as a different pitch
  // entirely and the run restarts. Must stay meaningfully wider than
  // implicitOnsetStabilityToleranceSemitones: this governs whether the run stays internally
  // coherent as "one note being held", and a naive full-window span check here breaks under
  // vibrato applied to the arrival note (common on any note held long enough to matter) -- if this
  // is too tight, vibrato depth can exceed it well before minStableMs elapses, so the run never
  // survives long enough to trigger, silently reintroducing the exact missed-note problem this
  // feature exists to fix. A running centroid instead adapts to the note being held (vibrato
  // averages toward its true center over time), so individual swung readings get absorbed instead
  // of evicted.
  implicitOnsetClusterToleranceSemitones: number;
}

export const DEFAULT_SCORE_FOLLOWER_CONFIG: ScoreFollowerConfig = {
  inTuneCentsThreshold: 15,
  onsetSettleMs: 40,
  minSamplesForVerdict: 2,
  pitchMatchToleranceSemitones: 3,
  pendingTransitionWindowMs: 150,
  resyncWindowAhead: 4,
  resyncWindowBehind: 2,
  attackSettleMs: 40,
  resyncMaxSequenceLength: 4,
  resyncTraceBufferSize: 50,
  implicitOnsetEnabled: true,
  implicitOnsetMinStableMs: 200,
  implicitOnsetStabilityToleranceSemitones: 1.5,
  implicitOnsetClusterToleranceSemitones: 2.2
};

interface PendingTransition {
  kind: "start" | "advance";
  // Onset instant, kept separate from deadlineMs -- deadlineMs gets overwritten when a fresh
  // onset extends a still-pending transition (see onLiveFrame()), but attackSettleMs must always
  // gate off the *original* onset, not a later extension.
  onsetMs: number;
  deadlineMs: number;
  // Whether this onset's settled pitch has already been recorded into the resync sequence buffer
  // -- extendResyncSequence() should run at most once per onset, not once per frame.
  sequenceRecorded: boolean;
  // Which trigger opened this transition -- "onset" (frame.onsetDetected) or "implicit" (a
  // sustained drift away from current with no real onset ever firing; see
  // ImplicitOnsetWatcher). Always "onset" for kind "start" -- the implicit trigger is scoped to
  // "advance" only, since the very first note has no "drift away from what" reference to compare
  // against.
  source: "onset" | "implicit";
}

interface SequenceMatch {
  // Offset (relative to the stale `current`, before any of this resync's notes were recorded)
  // where the matched sequence begins.
  startOffset: number;
}

export type ResyncTraceReason =
  | "next_note_immediate"
  | "sequence_ambiguous"
  | "sequence_note_discarded"
  | "sequence_confirmed"
  | "reattack_settled"
  | "deadline_expired";

export interface ResyncTraceEntry {
  timestampMs: number;
  reason: ResyncTraceReason;
  offset: number | null;
  fromStepIndex: number | null;
  toStepIndex: number | null;
  detectedFrequencyHz: number | null;
  // Which trigger produced this decision -- lets getTrace() (pulled live via
  // window.__scoreFollower.getTrace(), see src/App.tsx) distinguish "the ordinary onset path is
  // still broken" from "the new implicit path is misfiring" during live diagnosis.
  triggerSource: "onset" | "implicit";
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
  // Persists ACROSS multiple onsets/pendingTransitions while trying to resolve an ambiguous
  // resync -- unlike pendingTransition, this deliberately is NOT cleared when a single onset's
  // transition expires, since disambiguating a repeated-pitch passage requires accumulating
  // several onsets' worth of pitches. Cleared on any confirmed commit (of any kind) or on a
  // discarded/noise reading that doesn't extend it. See extendResyncSequence().
  private outOfSyncSequence: number[] = [];
  private readonly resyncTrace: ResyncTraceEntry[] = [];
  private readonly implicitOnsetWatcher: ImplicitOnsetWatcher;
  private readonly listeners = new Set<(state: ScoreFollowerState) => void>();

  constructor(cursor: ScoreCursor, config?: Partial<ScoreFollowerConfig>) {
    this.cursor = cursor;
    this.config = { ...DEFAULT_SCORE_FOLLOWER_CONFIG, ...config };
    this.implicitOnsetWatcher = new ImplicitOnsetWatcher({
      minStableMs: this.config.implicitOnsetMinStableMs,
      stabilityToleranceSemitones: this.config.implicitOnsetStabilityToleranceSemitones,
      clusterToleranceSemitones: this.config.implicitOnsetClusterToleranceSemitones
    });
  }

  start(): ScoreFollowerState {
    this.current = this.cursor.reset();
    this.status = this.current ? "awaiting_first_onset" : "completed";
    this.liveCentsOffFromExpected = null;
    this.history = [];
    this.activeRecord = null;
    this.pendingTransition = null;
    this.outOfSyncSequence = [];
    this.resyncTrace.length = 0;
    this.implicitOnsetWatcher.reset();
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
      // A real onset always takes precedence over (and invalidates) any in-progress implicit
      // drift accumulation -- see ImplicitOnsetWatcher's reset() below and beginTrackingCurrentNote().
      this.implicitOnsetWatcher.reset();

      if (this.pendingTransition) {
        // A fresh attack landed while still settling the previous one -- give it a new window
        // rather than letting the original deadline strand it. Deliberately does NOT reset
        // onsetMs -- attackSettleMs must keep gating off the original onset, not restart its
        // clock every time a new onset extends the window.
        this.pendingTransition.deadlineMs = frame.timestampMs + this.config.pendingTransitionWindowMs;
      } else {
        this.pendingTransition = {
          kind: this.status === "awaiting_first_onset" ? "start" : "advance",
          source: "onset",
          onsetMs: frame.timestampMs,
          deadlineMs: frame.timestampMs + this.config.pendingTransitionWindowMs,
          sequenceRecorded: false
        };
      }
    }

    if (this.pendingTransition) {
      if (frame.isSilent) {
        return this.getState();
      }

      if (this.pendingTransition.kind === "start") {
        // No resync applies before the piece has even begun -- same single-target check as
        // before scoping this feature down.
        if (this.matchesExpectedPitch(frame.frequencyHz, this.current?.primaryFrequencyHz ?? null)) {
          this.commitPendingTransition(frame.timestampMs);
          return this.emit();
        }
        if (frame.timestampMs > this.pendingTransition.deadlineMs) {
          this.pendingTransition = null;
        }
        return this.getState();
      }

      return this.resolveAdvancePendingTransition(frame);
    }

    if (this.status === "in_progress" && this.current !== null) {
      // Only reached with no pendingTransition active (the branch above always returns first
      // when one exists) -- this is what makes precedence with a real onset safe by construction,
      // not by added synchronization: a real onset either opens/extends a transition (this block
      // is unreachable that frame) or it doesn't fire at all, in which case this is the only
      // trigger in play.
      const watcherResult = this.config.implicitOnsetEnabled
        ? this.implicitOnsetWatcher.update(
            frame.frequencyHz,
            frame.timestampMs,
            frame.isSilent,
            this.current.primaryFrequencyHz
          )
        : { triggered: false, stableSinceMs: null, hasActiveWindow: false };

      if (watcherResult.triggered && watcherResult.stableSinceMs !== null) {
        this.pendingTransition = {
          kind: "advance",
          source: "implicit",
          onsetMs: watcherResult.stableSinceMs,
          deadlineMs: frame.timestampMs + this.config.pendingTransitionWindowMs,
          sequenceRecorded: false
        };
        return this.resolveAdvancePendingTransition(frame);
      }

      if (this.current.primaryFrequencyHz !== null && frame.frequencyHz !== null && !frame.isSilent) {
        const cents = centsOff(frame.frequencyHz, this.current.primaryFrequencyHz);
        this.liveCentsOffFromExpected = cents;

        // Skip recording a sample while the watcher has an unresolved drift candidate open --
        // those readings are, by construction, more than implicitOnsetStabilityToleranceSemitones
        // away from current's expected pitch, so counting them as mistuned readings OF current
        // would corrupt its accuracy verdict right before it's finalized.
        if (
          !watcherResult.hasActiveWindow &&
          frame.timestampMs - this.currentNoteStartedAtMs >= this.config.onsetSettleMs
        ) {
          this.activeRecord?.centsOffSamples.push(cents);
        }

        return this.emit();
      }
    }

    return this.getState();
  }

  // Only ever called for the "start" kind now -- "advance" resolution lives in
  // resolveAdvancePendingTransition()/commitAdvance() below, since it needs the fuller
  // fast-path/resync/reattack/deadline decision sequence rather than a single target check.
  private commitPendingTransition(timestampMs: number): void {
    this.pendingTransition = null;
    this.status = "in_progress";
    this.beginTrackingCurrentNote(timestampMs);
  }

  // Resolves a pending "advance" transition for one frame, in an order that specifically avoids
  // a previously reverted regression: an offset-0 (same-note re-attack) match must never be able
  // to preempt the retry window on the messy, transitionally-biased frames right after a genuine
  // onset. So offset-0 is checked AFTER the immediate-next-note fast path, and only once
  // attackSettleMs has elapsed since the transition's onset -- the same gate is used below for
  // recording this onset's reading into the resync sequence buffer.
  private resolveAdvancePendingTransition(frame: LivePitchFrame): ScoreFollowerState {
    const pending = this.pendingTransition;
    if (!pending) {
      return this.getState();
    }

    // Fast path: immediate next note (offset +1). Unchanged from the pre-resync behavior --
    // single-frame commit, no settle gate -- since this is the common case and already works.
    // Back in sync (if we weren't already): abandon any ambiguous sequence buffer from an
    // earlier, unrelated resync attempt.
    const source = pending.source;

    const nextNote = this.cursor.peekNextNote();
    if (this.matchesExpectedPitch(frame.frequencyHz, nextNote?.primaryFrequencyHz ?? null)) {
      this.outOfSyncSequence = [];
      this.commitAdvance(1, frame.timestampMs, frame.frequencyHz, "next_note_immediate", source);
      return this.emit();
    }

    const settled = frame.timestampMs - pending.onsetMs >= this.config.attackSettleMs;

    // Offset-0 / re-attack -- only eligible once settled. A match here is a no-op: stay on the
    // current note, but stop waiting out the rest of pendingTransitionWindowMs so ordinary cents
    // tracking can resume immediately. Also abandons any ambiguous sequence buffer -- landing
    // back on a clean re-attack of the current note is evidence the earlier ambiguity was noise.
    if (settled && this.matchesExpectedPitch(frame.frequencyHz, this.current?.primaryFrequencyHz ?? null)) {
      this.outOfSyncSequence = [];
      this.pushTrace({
        timestampMs: frame.timestampMs,
        reason: "reattack_settled",
        offset: 0,
        fromStepIndex: this.current?.stepIndex ?? null,
        toStepIndex: this.current?.stepIndex ?? null,
        detectedFrequencyHz: frame.frequencyHz,
        triggerSource: source
      });
      this.pendingTransition = null;
      return this.getState();
    }

    // Sequence-based resync: record this onset's settled pitch (once per onset, not once per
    // frame) and re-run the multi-note match. This onset's transition is done either way once
    // recorded -- no need to wait out the rest of pendingTransitionWindowMs, so the next onset
    // can start extending the sequence immediately rather than idling.
    if (settled && !pending.sequenceRecorded && frame.frequencyHz !== null) {
      pending.sequenceRecorded = true;
      this.pendingTransition = null;
      this.extendResyncSequence(frame.frequencyHz, frame.timestampMs, source);
      return this.getState();
    }

    // Deadline fallback: never got a usable settled reading for this onset at all (e.g.
    // frequencyHz stayed null throughout) -- give up on THIS onset, wait for the next one. Does
    // NOT clear outOfSyncSequence -- a still-ambiguous resync must survive across onsets.
    if (frame.timestampMs > pending.deadlineMs) {
      this.pushTrace({
        timestampMs: frame.timestampMs,
        reason: "deadline_expired",
        offset: null,
        fromStepIndex: this.current?.stepIndex ?? null,
        toStepIndex: this.current?.stepIndex ?? null,
        detectedFrequencyHz: frame.frequencyHz,
        triggerSource: source
      });
      this.pendingTransition = null;
    }

    return this.getState();
  }

  // Extends outOfSyncSequence with one more settled onset pitch and re-searches the score for it.
  // Commits once the match is unique, or once the buffer has grown to resyncMaxSequenceLength and
  // the closest remaining candidate is used as a tie-break; otherwise waits for the next onset to
  // narrow things down further. This is what fixes chronic lag on ambiguous/repeated passages: a
  // single played note is often a poor fingerprint (e.g. a repeated pitch matches more than one
  // spot nearby), so committing off one note alone means landing on a stale, already-passed
  // position while the player has already moved on -- perpetually one note behind. Matching a
  // short sequence is a much stronger fingerprint, and the final commit offset lands on the LAST
  // note of the matched sequence (what the player just finished playing), so the player's next
  // onset lines up with the ordinary fast path immediately instead of still catching up.
  private extendResyncSequence(frequencyHz: number, timestampMs: number, source: "onset" | "implicit"): void {
    const extended = [...this.outOfSyncSequence, frequencyHz];
    let sequence = extended;
    let candidates = this.findSequenceMatches(extended);

    if (candidates.length === 0) {
      // The rest of the buffer might itself have been noise -- try this reading alone before
      // discarding it, so one bad earlier reading can't permanently poison the search.
      const solo = this.findSequenceMatches([frequencyHz]);
      if (solo.length === 0) {
        this.pushTrace({
          timestampMs,
          reason: "sequence_note_discarded",
          offset: null,
          fromStepIndex: this.current?.stepIndex ?? null,
          toStepIndex: null,
          detectedFrequencyHz: frequencyHz,
          triggerSource: source
        });
        return;
      }
      sequence = [frequencyHz];
      candidates = solo;
    }

    if (candidates.length > 1 && sequence.length < this.config.resyncMaxSequenceLength) {
      this.outOfSyncSequence = sequence;
      this.pushTrace({
        timestampMs,
        reason: "sequence_ambiguous",
        offset: null,
        fromStepIndex: this.current?.stepIndex ?? null,
        toStepIndex: null,
        detectedFrequencyHz: frequencyHz,
        triggerSource: source
      });
      return;
    }

    const chosen = this.pickClosestSequenceMatch(candidates);
    this.outOfSyncSequence = [];
    const finalOffset = chosen.startOffset + sequence.length - 1;

    if (finalOffset === 0) {
      // Degenerate case: the matched sequence ends exactly back on the current note (e.g. the
      // player backtracked and replayed up to where they already were) -- a no-op, same as a
      // settled re-attack.
      this.pushTrace({
        timestampMs,
        reason: "reattack_settled",
        offset: 0,
        fromStepIndex: this.current?.stepIndex ?? null,
        toStepIndex: this.current?.stepIndex ?? null,
        detectedFrequencyHz: frequencyHz,
        triggerSource: source
      });
      return;
    }

    this.commitAdvance(finalOffset, timestampMs, frequencyHz, "sequence_confirmed", source);
  }

  // Searches every candidate start offset in [-resyncWindowBehind..resyncWindowAhead] for one
  // where the score's notes, read in order from that offset, match `sequence` pitch-for-pitch.
  // Peeks enough of the window to cover the full sequence length from either edge.
  private findSequenceMatches(sequence: number[]): SequenceMatch[] {
    const length = sequence.length;
    const ahead = this.config.resyncWindowAhead + length - 1;
    const behind = this.config.resyncWindowBehind + length - 1;
    const window = this.cursor.peekWindow(ahead, behind);

    const byOffset = new Map<number, CursorNoteInfo>();
    for (const entry of window) {
      byOffset.set(entry.offset, entry.note);
    }
    if (this.current) {
      byOffset.set(0, this.current);
    }

    const matches: SequenceMatch[] = [];
    for (let start = -this.config.resyncWindowBehind; start <= this.config.resyncWindowAhead; start += 1) {
      let allMatch = true;
      for (let i = 0; i < length; i += 1) {
        const note = byOffset.get(start + i);
        if (!note || !this.matchesExpectedPitch(sequence[i], note.primaryFrequencyHz)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matches.push({ startOffset: start });
      }
    }

    return matches;
  }

  // Prefers the smallest |startOffset|; on an exact tie, prefers forward -- an unforced,
  // arbitrary choice (skipping ahead is assumed a more common real-world mistake than replaying a
  // stale passage), easy to flip later.
  private pickClosestSequenceMatch(candidates: SequenceMatch[]): SequenceMatch {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (
        Math.abs(candidate.startOffset) < Math.abs(best.startOffset) ||
        (Math.abs(candidate.startOffset) === Math.abs(best.startOffset) && candidate.startOffset > best.startOffset)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  // Commits an advance/resync of `offset` notes (positive = forward, negative = backward) as the
  // resolution of the current pending "advance" transition.
  private commitAdvance(
    offset: number,
    timestampMs: number,
    detectedFrequencyHz: number | null,
    reason: ResyncTraceReason,
    source: "onset" | "implicit"
  ): void {
    const fromStepIndex = this.current?.stepIndex ?? null;
    this.pendingTransition = null;

    // Capture the skipped-note window before finalizeCurrentNote()/moving the cursor, but push
    // the outgoing note's own record FIRST so history stays in chronological/positional order --
    // the note being left was reached before the notes skipped past it.
    const skippedNotes = offset > 1 ? this.cursor.peekWindow(offset - 1, 0) : [];

    this.finalizeCurrentNote();

    if (offset > 1) {
      // Notes strictly between the old current and the resync target were skipped over --
      // record each as a zero-sample "not_played" stub so the review summary shows them as
      // missed instead of silently vanishing. This is forward bookkeeping for notes now being
      // left behind, not a retroactive edit of already-finalized history entries (out of scope
      // for this round).
      for (const entry of skippedNotes) {
        this.history.push(createEmptyRecord(entry.note));
      }
    }

    const landed = offset > 0 ? this.cursor.advanceBy(offset) : this.cursor.retreatBy(-offset);

    this.pushTrace({
      timestampMs,
      reason,
      offset,
      fromStepIndex,
      toStepIndex: landed?.stepIndex ?? null,
      detectedFrequencyHz,
      triggerSource: source
    });

    if (landed === null) {
      this.status = "completed";
      this.current = null;
      this.liveCentsOffFromExpected = null;
    } else {
      this.current = landed;
      this.beginTrackingCurrentNote(timestampMs);
    }
  }

  private pushTrace(entry: ResyncTraceEntry): void {
    this.resyncTrace.push(entry);
    if (this.resyncTrace.length > this.config.resyncTraceBufferSize) {
      this.resyncTrace.shift();
    }
  }

  // Pull-based, deliberately not part of ScoreFollowerState/emit() -- state is emitted on
  // essentially every live frame, and embedding a growing trace array there would force a fresh
  // array reference on every emit even on frames with no resync activity. Read on demand instead
  // (a debug panel, or the offline resync test harness).
  getTrace(): readonly ResyncTraceEntry[] {
    return this.resyncTrace;
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
    // Every commit path (fast path, reattack, sequence resync) lands here -- reset unconditionally
    // so no stale drift accumulation from tracking the OLD current ever carries into the new one.
    this.implicitOnsetWatcher.reset();
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
