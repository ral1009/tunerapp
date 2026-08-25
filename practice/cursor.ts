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
  // Median of centsOffSamples; null if empty (including when inferredFromRepeat -- see below,
  // which copies the PREVIOUS note's averageCentsOff here rather than leaving null).
  averageCentsOff: number | null;
  verdict: NoteVerdict;
  // True when this note got zero usable pitch samples of its own (would otherwise be
  // "not_played") but immediately follows an identically-pitched note that DID get a real
  // verdict, and inherited that note's verdict/averageCentsOff instead -- see
  // finalizeCurrentNote(). Common on same-pitch repeated notes (e.g. "Twinkle Twinkle"'s "D D"):
  // the second note produces no fresh onset-adjacent settle window distinct enough from the
  // first to collect its own samples, but there's no reason to believe its intonation differs
  // from the note immediately preceding it at the same pitch. False for every ordinarily-measured
  // or genuinely-not-played record.
  inferredFromRepeat: boolean;
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
  // Mirrors the most recent live frame's LivePitchFrame.reason -- purely diagnostic, does not
  // drive any resync/onset decision. Surfaces *why* a frame produced no usable pitch (silence vs.
  // low_confidence vs. outside_expected_window vs. detector_no_pitch vs. outside_violin_range)
  // for live debugging via window.__scoreFollower, e.g. distinguishing "the player genuinely
  // stopped" from "the detector is rejecting real signal" when resync seems stuck.
  lastPitchReason: LivePitchFrame["reason"];
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
  // Kill switch for edit-distance-tolerant sequence resync matching (below), independent of
  // implicitOnsetEnabled -- flip to false to instantly revert findSequenceMatches() to its
  // original exact-contiguous-only behavior for live A/B comparison, same convention as
  // implicitOnsetEnabled. Defaults to false until live-validated: this changes core resync
  // matching behavior (not an additive/diagnostic-only change like lastPitchReason), so per this
  // project's history of harness-green/live-broken resync regressions, it ships off by default
  // and gets flipped on deliberately once a live session confirms it behaves as intended.
  // Confirmed live (deletion-tolerance only, insertion off): correctly bridges a single missed
  // note. How many CONSECUTIVE missed notes it can bridge is controlled separately by
  // fuzzySequenceMaxSkips below.
  fuzzySequenceMatchingEnabled: boolean;
  // How many score notes a deletion-tolerant match may skip in total when bridging a gap (see
  // matchSequenceWithSkips) -- i.e. how many CONSECUTIVE missed onsets it can recover from, not
  // just one. Defaults to 1, exactly matching the originally-shipped, live-confirmed behavior --
  // bump this deliberately (2, 3, ...) to test bridging larger gaps, since a bigger value widens
  // the search space and therefore the risk of a wrong-but-plausible match; there's no evidence
  // yet on where that risk becomes noticeable, so this needs its own live A/B round same as any
  // other value change in this file. Only affects deletion-tolerant matching -- insertion-
  // tolerant matching (fuzzyInsertionMatchingEnabled) still only ever excludes a single observed
  // reading, unchanged.
  fuzzySequenceMaxSkips: number;
  // Separate kill switch, ADDITIONAL to fuzzySequenceMatchingEnabled (both must be true), for
  // specifically the insertion-tolerant half of fuzzy matching (see
  // sequenceMatchesWithInsertion/SequenceMatch.editDistance's doc comment). Split out and
  // defaulted off after live testing on real playing: deletion-tolerant matching never discards
  // anything the player actually played, but insertion-tolerant matching, by construction, DOES --
  // it treats one buffered reading as noise to make the rest fit nearby. Confirmed live: a
  // 3-reading buffer where the middle reading was genuine noise resolved by discarding a real
  // reading instead (one that was nearly identical in pitch to another in the buffer), landing a
  // resync short of the player's actual position -- silently biased toward the nearest
  // good-enough explanation rather than the correct farther one. Deletion-tolerant matching alone
  // already covers the diagnosed root cause (a missed note leaving a gap); insertion-tolerant
  // matching is the riskier, more speculative half and needs its own dedicated live validation
  // before it's trusted to actually commit a resync on its own.
  fuzzyInsertionMatchingEnabled: boolean;
  // Kill switch for scaling implicitOnsetMinStableMs by an empirical tempo estimate instead of
  // using its fixed value always. Rationale: at a fast tempo, a note can genuinely last less than
  // the static default (200ms), meaning the implicit trigger structurally could never fire for it
  // in time no matter how real the legato transition is; at a slow tempo, the static default may
  // be needlessly twitchy relative to how long notes actually last. Off by default per this
  // project's standing convention for any behavior-changing addition -- needs its own live
  // validation round, separate from and after fuzzySequenceMatchingEnabled's.
  adaptiveStabilityWindowEnabled: boolean;
  // Fraction of the CURRENT (departing) note's estimated real-time duration used as the adaptive
  // minStableMs target -- see computeAdaptiveMinStableMs(). An "informed but not certain" number,
  // not derived from anything rigorous: large enough that a genuine full-length legato note
  // reliably clears it, small enough to meaningfully beat the static 200ms default at faster
  // tempos. Tune with live evidence, not in the abstract.
  adaptiveStabilityWindowFraction: number;
  // Hard floor under the adaptive value, regardless of tempo -- mirrors
  // implicitOnsetMinStableMs's own reasoning (must exceed one full violin vibrato cycle,
  // ~125-200ms at 5-8Hz) so a very fast estimated tempo can never shrink the window into the
  // range where heavy vibrato risks a false trigger. Set at the conservative (higher) end of that
  // range, same bias as implicitOnsetMinStableMs's own default.
  adaptiveStabilityWindowFloorMs: number;
  // How many recent (departing note actual elapsed ms / its notated quarter-note duration)
  // samples to keep for the rolling tempo estimate -- see recordTempoSample(). A short window
  // deliberately favors reacting to the player's CURRENT pace (they sped up/slowed down mid-piece)
  // over a piece-wide average, at the cost of being noisier per-sample; the median (not mean) is
  // what actually absorbs that noise, same rationale as this codebase's other median smoothers.
  tempoEstimateSampleCount: number;
  // A note shorter than this (in quarter-note units) is never used as a tempo sample -- its
  // observed elapsed time is dominated by attackSettleMs/onset-detection latency relative to its
  // own short notated duration, making the IMPLIED tempo estimate proportionally noisier the
  // shorter the note is. 0.5 = an eighth note; anything at or above that is trusted.
  tempoEstimateMinQuarterNotes: number;
  // Kill switch for acting on LivePitchFrame.onsetConfidence (audio/captureModule/index.ts's
  // flux/energy fusion vote). Off by default per this project's standing convention -- computing
  // the confidence signal is always-on/cheap (like tempo sampling in Phase 2), but ACTING on it
  // (extraSettleMs below) is a behavior change that needs its own live validation round.
  energyOnsetFusionEnabled: boolean;
  // Extra time (added to both pendingTransitionWindowMs's deadline and attackSettleMs's settle
  // gate -- see extraSettleMsFor()) given to a pending transition whose opening/most-recently-
  // extending onset was fusion-"low" confidence (only one of the two onset detectors fired for
  // it). Rationale: a single-detector onset is more likely to be a borderline/marginal attack (or
  // occasionally a false one), so it's worth a bit more patience before trusting a reading that
  // follows it, rather than treating it exactly like a confidently double-detected onset. Applies
  // ONLY when energyOnsetFusionEnabled is on; "informed but not certain," needs live tuning.
  lowConfidenceOnsetExtraSettleMs: number;
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
  implicitOnsetClusterToleranceSemitones: 2.2,
  fuzzySequenceMatchingEnabled: false,
  fuzzySequenceMaxSkips: 1,
  fuzzyInsertionMatchingEnabled: false,
  adaptiveStabilityWindowEnabled: false,
  adaptiveStabilityWindowFraction: 0.75,
  adaptiveStabilityWindowFloorMs: 150,
  tempoEstimateSampleCount: 4,
  tempoEstimateMinQuarterNotes: 0.5,
  energyOnsetFusionEnabled: false,
  lowConfidenceOnsetExtraSettleMs: 100
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
  // Fusion confidence of the onset that opened/most-recently-extended this transition (see
  // audio/captureModule/index.ts's flux/energy fusion) -- null for source "implicit" (that
  // trigger has its own, unrelated confidence mechanism: a sustained hold over minStableMs) and
  // for a real onset before energyOnsetFusionEnabled has any data to report. Drives
  // extraSettleMs() below.
  onsetConfidence: "high" | "low" | null;
}

interface SequenceMatch {
  // Offset (relative to the stale `current`, before any of this resync's notes were recorded)
  // where the matched sequence begins.
  startOffset: number;
  // Offset of the score note the LAST element of the observed sequence actually landed on. Equal
  // to startOffset + sequence.length - 1 for an exact (editDistance 0) match, but diverges for a
  // fuzzy match: a deletion-tolerant match (the score has one note the player's onset detection
  // never caught) lands one note further ahead than the naive length-based formula would predict,
  // and an insertion-tolerant match (one observed reading was noise/a spurious re-articulation,
  // not a real score note) lands one note short of it. commitAdvance uses this directly instead
  // of re-deriving it from startOffset + length, since that formula is only valid for exact
  // matches.
  endOffset: number;
  // 0 for an exact contiguous match. For a deletion-tolerant match, the actual number of score
  // notes skipped to bridge the gap (1, 2, ... up to fuzzySequenceMaxSkips) -- every observed
  // reading is still accounted for, just spread across more score notes than an exact match
  // would use. INSERTION_EDIT_DISTANCE (see below) for an insertion-tolerant match (one observed
  // reading is excluded as noise -- real evidence is discarded to make the rest fit), regardless
  // of how few score notes were actually skipped. Deletion is deliberately ranked ahead of
  // insertion always, not just at equal skip counts: a deletion match explains everything that
  // was actually heard, while an insertion match throws part of it away, so it's weaker evidence
  // even when it would nominally need fewer skips. This matters in practice -- when a repeated
  // pitch elsewhere in the score makes one observed reading ambiguous on its own, insertion-
  // tolerant matching can rediscover that same ambiguity by treating the OTHER reading as the
  // noise, producing multiple insertion candidates that would otherwise tie with (or crowd out) a
  // single, correct deletion candidate. Ranking insertion strictly worse means those degenerate
  // its-own-noise interpretations never outcompete a genuine deletion match. See
  // extendResyncSequence's best-tier filtering, which relies on this ordering (and on lower
  // deletion skip counts ranking better than higher ones) to only treat same-tier candidates as
  // real ambiguity.
  editDistance: number;
}

// Sentinel editDistance for an insertion-tolerant match -- deliberately far larger than any
// realistic fuzzySequenceMaxSkips value, so insertion NEVER outranks a deletion-tolerant match
// regardless of how many notes that deletion match had to skip (see SequenceMatch.editDistance).
export const INSERTION_EDIT_DISTANCE = 1000;

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
  // SequenceMatch.editDistance of the match this decision was based on (0 exact, 1
  // deletion-tolerant, 2 insertion-tolerant -- see SequenceMatch), when this decision came from
  // findSequenceMatches() at all (sequence_confirmed, and the degenerate finalOffset===0 case of
  // reattack_settled reached via extendResyncSequence). Null for next_note_immediate (the fast
  // path never calls findSequenceMatches), the OTHER reattack_settled site (a direct pitch check
  // in resolveAdvancePendingTransition, also no findSequenceMatches call), and deadline_expired.
  // Exists to make a resync landing SHORT of the player's actual position (a match that only
  // bridges a 1-note gap when the real gap was larger) diagnosable from the trace alone, instead
  // of having to guess between "the edit-distance tolerance was insufficient" and other causes.
  editDistance: number | null;
  // Length of the observed-pitch sequence (outOfSyncSequence, including this reading) involved in
  // this decision, when applicable (sequence_note_discarded, sequence_ambiguous,
  // sequence_confirmed, and the degenerate reattack_settled case above). Null otherwise. Watching
  // this climb across consecutive sequence_ambiguous entries without ever reaching
  // sequence_confirmed is itself a signal that the real gap exceeds what fuzzy matching (or the
  // resync window bounds) can bridge.
  sequenceLength: number | null;
  // Fusion confidence of the onset that opened/most-recently-extended the pending transition this
  // decision resolves (see PendingTransition.onsetConfidence) -- null for triggerSource
  // "implicit" (not applicable) or when no pending transition was involved. Lets a live session
  // correlate "resolved slower/later than expected" with "it was a low-confidence onset that got
  // extraSettleMsFor() patience," rather than guessing.
  onsetConfidence: "high" | "low" | null;
}

// Exported for practice/metronomeFollower.ts, which needs the exact same cents/median/verdict
// math so the two tracking modes' NoteAccuracyRecord output stays directly comparable (same
// ScoreFollowerState shape consumed by the same App.tsx UI -- see metronomeFollower.ts's own
// header comment for why it duplicates none of this).
export function centsOff(frequencyHz: number, expectedFrequencyHz: number): number {
  return 1200 * Math.log2(frequencyHz / expectedFrequencyHz);
}

function semitoneDistance(frequencyAHz: number, frequencyBHz: number): number {
  return Math.abs(12 * Math.log2(frequencyAHz / frequencyBHz));
}

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function createEmptyRecord(note: CursorNoteInfo): NoteAccuracyRecord {
  return {
    stepIndex: note.stepIndex,
    measureIndex: note.measureIndex,
    pitchLabel: note.pitchLabel,
    expectedFrequencyHz: note.primaryFrequencyHz ?? 0,
    centsOffSamples: [],
    averageCentsOff: null,
    verdict: "not_played",
    inferredFromRepeat: false
  };
}

export class ScoreFollower {
  private readonly cursor: ScoreCursor;
  private readonly config: ScoreFollowerConfig;
  private status: ScoreFollowerStatus = "idle";
  private current: CursorNoteInfo | null = null;
  private liveCentsOffFromExpected: number | null = null;
  private lastPitchReason: LivePitchFrame["reason"] = null;
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
  // Rolling buffer of recent (elapsed ms / notated quarter-note duration) samples, one per
  // committed note transition -- see recordTempoSample()/estimateMsPerQuarterNote(). Recorded
  // unconditionally (cheap bookkeeping) regardless of adaptiveStabilityWindowEnabled; only its
  // USE (computeAdaptiveMinStableMs) is gated by the flag, so enabling the feature later doesn't
  // start cold.
  private recentMsPerQuarterNote: number[] = [];
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
    this.lastPitchReason = null;
    this.history = [];
    this.activeRecord = null;
    this.pendingTransition = null;
    this.outOfSyncSequence = [];
    this.recentMsPerQuarterNote = [];
    this.resyncTrace.length = 0;
    this.implicitOnsetWatcher.reset();
    return this.emit();
  }

  onLiveFrame(frame: LivePitchFrame): ScoreFollowerState {
    if (this.status !== "awaiting_first_onset" && this.status !== "in_progress") {
      return this.getState();
    }

    this.lastPitchReason = frame.reason;

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
        // clock every time a new onset extends the window. Confidence is re-derived from THIS
        // extending frame (not the original), matching captureModule's own "latest onset wins"
        // treatment of its pending-onset timestamp.
        this.pendingTransition.onsetConfidence = frame.onsetConfidence;
        this.pendingTransition.deadlineMs =
          frame.timestampMs + this.config.pendingTransitionWindowMs + this.extraSettleMsFor(frame.onsetConfidence);
      } else {
        this.pendingTransition = {
          kind: this.status === "awaiting_first_onset" ? "start" : "advance",
          source: "onset",
          onsetMs: frame.timestampMs,
          deadlineMs: frame.timestampMs + this.config.pendingTransitionWindowMs + this.extraSettleMsFor(frame.onsetConfidence),
          sequenceRecorded: false,
          onsetConfidence: frame.onsetConfidence
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
            this.current.primaryFrequencyHz,
            this.config.adaptiveStabilityWindowEnabled ? this.computeAdaptiveMinStableMs() : undefined
          )
        : { triggered: false, stableSinceMs: null, hasActiveWindow: false };

      if (watcherResult.triggered && watcherResult.stableSinceMs !== null) {
        this.pendingTransition = {
          kind: "advance",
          source: "implicit",
          onsetMs: watcherResult.stableSinceMs,
          deadlineMs: frame.timestampMs + this.config.pendingTransitionWindowMs,
          sequenceRecorded: false,
          onsetConfidence: null
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
      this.commitAdvance(1, frame.timestampMs, frame.frequencyHz, "next_note_immediate", source, null, null, pending.onsetConfidence);
      return this.emit();
    }

    const settled =
      frame.timestampMs - pending.onsetMs >= this.config.attackSettleMs + this.extraSettleMsFor(pending.onsetConfidence);

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
        triggerSource: source,
        editDistance: null,
        sequenceLength: null,
        onsetConfidence: pending.onsetConfidence
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
      this.extendResyncSequence(frame.frequencyHz, frame.timestampMs, source, pending.onsetConfidence);
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
        triggerSource: source,
        editDistance: null,
        sequenceLength: null,
        onsetConfidence: pending.onsetConfidence
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
  private extendResyncSequence(
    frequencyHz: number,
    timestampMs: number,
    source: "onset" | "implicit",
    onsetConfidence: "high" | "low" | null
  ): void {
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
          triggerSource: source,
          editDistance: null,
          sequenceLength: extended.length,
          onsetConfidence
        });
        return;
      }
      sequence = [frequencyHz];
      candidates = solo;
    }

    // With fuzzy matching enabled, `candidates` can mix edit-distance tiers for the same buffer
    // (e.g. one genuine deletion-tolerant match alongside several degenerate insertion-tolerant
    // ones -- see SequenceMatch.editDistance). Only the BEST tier should count as real ambiguity:
    // a worse-tier candidate coexisting with a unique best-tier one isn't genuine uncertainty,
    // it's a weaker alternative explanation that should simply lose, not force more waiting.
    const bestDistance = Math.min(...candidates.map((candidate) => candidate.editDistance));
    const bestCandidates = candidates.filter((candidate) => candidate.editDistance === bestDistance);

    if (bestCandidates.length > 1 && sequence.length < this.config.resyncMaxSequenceLength) {
      this.outOfSyncSequence = sequence;
      this.pushTrace({
        timestampMs,
        reason: "sequence_ambiguous",
        offset: null,
        fromStepIndex: this.current?.stepIndex ?? null,
        toStepIndex: null,
        detectedFrequencyHz: frequencyHz,
        triggerSource: source,
        editDistance: bestDistance,
        sequenceLength: sequence.length,
        onsetConfidence
      });
      return;
    }

    const chosen = this.pickClosestSequenceMatch(bestCandidates);
    this.outOfSyncSequence = [];
    // endOffset (not startOffset + sequence.length - 1) -- only equivalent for an exact match;
    // see SequenceMatch.endOffset's doc comment for why a fuzzy match's landing position diverges.
    const finalOffset = chosen.endOffset;

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
        triggerSource: source,
        editDistance: chosen.editDistance,
        sequenceLength: sequence.length,
        onsetConfidence
      });
      return;
    }

    this.commitAdvance(
      finalOffset,
      timestampMs,
      frequencyHz,
      "sequence_confirmed",
      source,
      chosen.editDistance,
      sequence.length,
      onsetConfidence
    );
  }

  // Searches every candidate start offset in [-resyncWindowBehind..resyncWindowAhead] for one
  // where the score's notes, read in order from that offset, match `sequence` pitch-for-pitch.
  // Peeks enough of the window to cover the full sequence length from either edge (plus extra
  // room ahead, scaled by fuzzySequenceMaxSkips, when fuzzy matching is enabled -- a
  // deletion-tolerant match's alignment can reach that many notes further than an exact match of
  // the same length would; no extra room is needed behind, since matchSequenceWithSkips only ever
  // walks forward from `start`).
  //
  // When fuzzySequenceMatchingEnabled, also searches a skip-tolerant alignment at each start
  // offset that didn't already match exactly: the score has up to fuzzySequenceMaxSkips notes the
  // player's onset detection never caught (a "deletion" from the observed sequence's perspective
  // -- see matchSequenceWithSkips). This directly targets exact matching's documented fragility: a
  // single missed reading anywhere in the window previously broke that candidate entirely, which
  // is the diagnosed root cause behind resync resolving rarely on real playing. When ADDITIONALLY
  // fuzzyInsertionMatchingEnabled, also tries the reverse: the observed sequence has one extra
  // reading that isn't a real score note (an "insertion" -- spurious noise or a duplicate
  // re-articulation; see sequenceMatchesWithInsertion and fuzzyInsertionMatchingEnabled's doc
  // comment for why this is gated separately, stays single-skip-only, and defaults off). Only
  // engages once sequence.length >= 2 -- at length 1 a "deletion" match is just an exact match
  // some notes over (already covered by the exact loop at a different start), and "insertion"
  // needs at least 2 elements to have anything left over after excluding one as noise.
  private findSequenceMatches(sequence: number[]): SequenceMatch[] {
    const length = sequence.length;
    const fuzzyEnabled = this.config.fuzzySequenceMatchingEnabled && length >= 2;
    const insertionEnabled = fuzzyEnabled && this.config.fuzzyInsertionMatchingEnabled;
    const maxSkips = fuzzyEnabled ? Math.max(0, this.config.fuzzySequenceMaxSkips) : 0;
    const ahead = this.config.resyncWindowAhead + length - 1 + maxSkips;
    // No extra behind padding needed for either fuzzy mode: matchSequenceWithSkips only ever
    // walks forward from `start`, and insertion-tolerant matching's max reach (start+length-2) is
    // already within the base length-1 term below.
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
        matches.push({ startOffset: start, endOffset: start + length - 1, editDistance: 0 });
        continue;
      }

      if (!fuzzyEnabled) {
        continue;
      }

      const deletionMatch = maxSkips > 0 ? this.matchSequenceWithSkips(sequence, byOffset, start, maxSkips) : null;
      if (deletionMatch) {
        matches.push({ startOffset: start, endOffset: deletionMatch.endOffset, editDistance: deletionMatch.skipsUsed });
      } else if (insertionEnabled && this.sequenceMatchesWithInsertion(sequence, byOffset, start)) {
        matches.push({ startOffset: start, endOffset: start + length - 2, editDistance: INSERTION_EDIT_DISTANCE });
      }
    }

    return matches;
  }

  // Greedily aligns `sequence` against the score starting at `start`, allowed to skip up to
  // maxSkips score notes along the way -- i.e. the player's onset detection missed that many
  // CONSECUTIVE (or scattered) notes, so they're simply absent from the observed sequence. Walks
  // forward one score offset at a time: if it matches the current sequence element, consume it
  // and advance to the next element; if not, spend one skip and try the next score offset,
  // failing once skips run out before every element is matched. Greedy-earliest-match is standard
  // for this class of subsequence problem and keeps the search linear in window size rather than
  // exploring every possible skip placement -- unlike the old single-skip version, WHERE the
  // skips land can change which score offset the last element lands on, so this returns the
  // actual endOffset/skip count reached rather than leaving the caller to derive it from `length`
  // alone (see SequenceMatch.endOffset's doc comment).
  private matchSequenceWithSkips(
    sequence: number[],
    byOffset: ReadonlyMap<number, CursorNoteInfo>,
    start: number,
    maxSkips: number
  ): { endOffset: number; skipsUsed: number } | null {
    let scoreOffset = start;
    let skipsUsed = 0;
    let lastMatchedOffset = start - 1;

    for (let i = 0; i < sequence.length; i += 1) {
      let matched = false;
      while (true) {
        const note = byOffset.get(scoreOffset);
        if (note && this.matchesExpectedPitch(sequence[i], note.primaryFrequencyHz)) {
          lastMatchedOffset = scoreOffset;
          scoreOffset += 1;
          matched = true;
          break;
        }
        if (skipsUsed >= maxSkips) {
          break;
        }
        skipsUsed += 1;
        scoreOffset += 1;
      }
      if (!matched) {
        return null;
      }
    }

    return { endOffset: lastMatchedOffset, skipsUsed };
  }

  // Mirror of sequenceMatchesWithDeletion: checks whether `sequence` aligns against the score
  // starting at `start` if exactly one OBSERVED reading (at some position in the sequence) is
  // excluded -- treated as noise or a spurious extra re-articulation rather than a real score
  // note. The excluded reading itself is never pitch-checked against anything; only the remaining
  // length-1 readings need to match.
  private sequenceMatchesWithInsertion(
    sequence: number[],
    byOffset: ReadonlyMap<number, CursorNoteInfo>,
    start: number
  ): boolean {
    const length = sequence.length;
    for (let skip = 0; skip < length; skip += 1) {
      let allMatch = true;
      for (let i = 0; i < length; i += 1) {
        if (i === skip) {
          continue;
        }
        const scoreOffset = i < skip ? start + i : start + i - 1;
        const note = byOffset.get(scoreOffset);
        if (!note || !this.matchesExpectedPitch(sequence[i], note.primaryFrequencyHz)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        return true;
      }
    }
    return false;
  }

  // Prefers an exact match over a fuzzy one regardless of offset distance (fuzzy matching is a
  // fallback for when exact matching finds nothing, not a replacement for it -- see
  // SequenceMatch.editDistance). Among matches of equal editDistance, prefers the smallest
  // |startOffset|; on an exact tie, prefers forward -- an unforced, arbitrary choice (skipping
  // ahead is assumed a more common real-world mistake than replaying a stale passage), easy to
  // flip later.
  private pickClosestSequenceMatch(candidates: SequenceMatch[]): SequenceMatch {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (
        candidate.editDistance < best.editDistance ||
        (candidate.editDistance === best.editDistance &&
          (Math.abs(candidate.startOffset) < Math.abs(best.startOffset) ||
            (Math.abs(candidate.startOffset) === Math.abs(best.startOffset) && candidate.startOffset > best.startOffset)))
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
    source: "onset" | "implicit",
    editDistance: number | null,
    sequenceLength: number | null,
    onsetConfidence: "high" | "low" | null
  ): void {
    const fromStepIndex = this.current?.stepIndex ?? null;
    this.pendingTransition = null;

    // Must run before finalizeCurrentNote()/moving the cursor -- relies on this.current and
    // this.currentNoteStartedAtMs still referring to the OUTGOING note.
    this.recordTempoSample(timestampMs);

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
      triggerSource: source,
      editDistance,
      sequenceLength,
      onsetConfidence
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

  // Records one (elapsed ms / notated quarter-note duration) sample for the outgoing note, using
  // this.current/this.currentNoteStartedAtMs -- MUST be called before either is overwritten by
  // the commit in progress. Guards against notes too short to trust (see
  // tempoEstimateMinQuarterNotes's doc comment) and against a non-positive elapsed time (e.g. a
  // resync landing offset 0, which never reaches here since commitAdvance is only called for a
  // real advance/retreat, but defensive regardless).
  private recordTempoSample(transitionTimestampMs: number): void {
    if (!this.current || this.current.durationQuarterNotes < this.config.tempoEstimateMinQuarterNotes) {
      return;
    }

    const elapsedMs = transitionTimestampMs - this.currentNoteStartedAtMs;
    if (elapsedMs <= 0) {
      return;
    }

    const impliedMsPerQuarterNote = elapsedMs / this.current.durationQuarterNotes;
    this.recentMsPerQuarterNote.push(impliedMsPerQuarterNote);
    if (this.recentMsPerQuarterNote.length > this.config.tempoEstimateSampleCount) {
      this.recentMsPerQuarterNote.shift();
    }
  }

  // Median of recentMsPerQuarterNote (median, not mean, for the same outlier-robustness reason as
  // this codebase's other rolling estimators) -- null before any sample has been recorded (e.g.
  // still on the very first note of the piece), in which case callers should fall back to a
  // static default rather than treating null as zero.
  private estimateMsPerQuarterNote(): number | null {
    return median(this.recentMsPerQuarterNote);
  }

  // Tempo-scaled candidate for ImplicitOnsetWatcher's minStableMs, or undefined when there isn't
  // enough information yet to compute one (no current note, a rest, or no tempo samples recorded
  // yet) -- undefined tells the watcher to fall back to its own static constructor default rather
  // than this method inventing a number from nothing. See
  // ScoreFollowerConfig.adaptiveStabilityWindowFraction/FloorMs for what the scaling and floor
  // actually mean.
  private computeAdaptiveMinStableMs(): number | undefined {
    if (!this.current || this.current.durationQuarterNotes <= 0) {
      return undefined;
    }

    const msPerQuarterNote = this.estimateMsPerQuarterNote();
    if (msPerQuarterNote === null) {
      return undefined;
    }

    const expectedNoteDurationMs = this.current.durationQuarterNotes * msPerQuarterNote;
    const scaled = expectedNoteDurationMs * this.config.adaptiveStabilityWindowFraction;
    return Math.max(this.config.adaptiveStabilityWindowFloorMs, scaled);
  }

  // Extra settle/deadline time for a pending transition sourced from a "low" fusion-confidence
  // onset, or 0 otherwise (high confidence, no confidence data, implicit source, or the feature
  // disabled). See lowConfidenceOnsetExtraSettleMs's config doc comment.
  private extraSettleMsFor(onsetConfidence: "high" | "low" | null): number {
    return this.config.energyOnsetFusionEnabled && onsetConfidence === "low" ? this.config.lowConfidenceOnsetExtraSettleMs : 0;
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

    // A note that got zero usable samples (would otherwise report as "not_played") but is an
    // exact-pitch repeat of the immediately preceding, already-measured note inherits that note's
    // verdict instead -- see NoteAccuracyRecord.inferredFromRepeat's doc comment for why. Exact
    // frequency equality (not a semitone-tolerance comparison) is deliberate: both values come
    // from the same CursorNoteInfo.primaryFrequencyHz computation for a written pitch, so a real
    // repeat produces an exactly-equal float; this should never fuzzy-match two DIFFERENT written
    // pitches that merely happen to be close. Looks at history's last entry (the chronologically
    // preceding note), not stepIndex-1 -- correct for normal forward playing, though a prior
    // backward resync could in principle make those differ (an existing, separately-documented
    // out-of-scope case -- see history's own duplicate-stepIndex comment at commitAdvance).
    if (this.activeRecord.centsOffSamples.length === 0) {
      const previous = this.history[this.history.length - 1];
      if (
        previous &&
        previous.verdict !== "not_played" &&
        previous.expectedFrequencyHz === this.activeRecord.expectedFrequencyHz
      ) {
        this.activeRecord.averageCentsOff = previous.averageCentsOff;
        this.activeRecord.verdict = previous.verdict;
        this.activeRecord.inferredFromRepeat = true;
      }
    }

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
