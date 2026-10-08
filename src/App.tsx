import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import {
  createMicrophoneCaptureController,
  type LiveCaptureState,
  type MicrophoneCaptureController,
  type StartCaptureOptions
} from "../audio/captureModule";
import { importPhotoToScore, type OmrImportResult } from "../score/omrImport";
import { importMusicXmlToScore } from "../score/musicxmlImport";
import { applyNoteCorrectionsToXml } from "../score/correctionUI/noteXmlCorrection";
import { renderScore, type MeasureBox, type RenderedScoreHandle, type ScoreCursor, type NoteHighlight } from "../score/renderer";
import type { CursorNoteInfo, QuarterIndexEntry } from "../score/renderer/scoreCursor";
import { ScoreFollower, DEFAULT_SCORE_FOLLOWER_CONFIG, type ScoreFollowerState } from "../practice/cursor";
import { MetronomeScoreFollower, DEFAULT_METRONOME_FOLLOWER_CONFIG } from "../practice/metronomeFollower";
import { MatchmakerScoreFollower, DEFAULT_MATCHMAKER_FOLLOWER_CONFIG } from "../practice/matchmakerFollower";
import {
  analysisFrameSizeFor,
  OFFLINE_ANALYSIS_INTERVAL_SECONDS,
  OFFLINE_SMOOTHING_FRAMES,
  scoreRecordingOffline,
  type AlignmentPoint
} from "../practice/offlineIntonationScorer";
import { MatchmakerStream, type MatchmakerStreamStatus } from "../audio/matchmakerStream";
import { createBeatClock, computeTimeSignatureSegments, type BeatClock, type ClickSubdivision } from "../practice/metronome";
import { DEFAULT_GRADING, STRICTNESS_BANDS, gradingOptions, summarizePracticeSession, type GradeReference, type GradeStrictness } from "../practice/reviewSummary";
import { downloadTake, type SavedTake } from "../practice/takeExport";
import { historyInRegion, passIsOver, resolveSpotRegion, summarizePass, type SpotPassResult, type SpotRegion } from "../practice/spotPractice";

type ImportState = "idle" | "loading" | "success" | "error";

const LIVE_CAPTURE_OPTIONS: StartCaptureOptions = {
  frameSize: 2048,
  hopSize: 512,
  // Below this, PitchDetector treats the reading as unreliable and returns frequencyHz: null
  // (audio/pitchDetector.ts), which the UI already renders as "No note" (see noteDisplay below) --
  // 0.4 was letting low-confidence background noise through as a falsely-confident detected pitch.
  confidenceThreshold: 0.67,
  silenceRmsThreshold: 0.005,
  lowCutHz: 80,
  highCutHz: 3500,
  smoothingWindowFrames: 5,
  expectedNoteWindowSemitones: 3,
  channelCount: 1
};

function formatConfidence(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatFrequency(value: number | null): string {
  if (value === null) {
    return "--";
  }

  return `${value.toFixed(2)} Hz`;
}

function formatCents(value: number | null): string {
  if (value === null) {
    return "--";
  }

  const rounded = value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
  return `${rounded} cents`;
}

function formatTempo(value: number | null): string {
  if (value === null) {
    return "--";
  }

  return `${value} BPM`;
}

// Quarter-note-unit values, matching NOTE_TYPE_BY_QUARTER_NOTES in
// score/correctionUI/noteXmlCorrection.ts -- only these land on a clean visual note glyph when
// corrected; see that file's comment for why an off-list value still updates timing but not the
// rendered symbol.
const CORRECTION_DURATION_OPTIONS: Array<{ label: string; quarterNotes: number }> = [
  { label: "Whole", quarterNotes: 4 },
  { label: "Dotted half", quarterNotes: 3 },
  { label: "Half", quarterNotes: 2 },
  { label: "Dotted quarter", quarterNotes: 1.5 },
  { label: "Quarter", quarterNotes: 1 },
  { label: "Dotted eighth", quarterNotes: 0.75 },
  { label: "Eighth", quarterNotes: 0.5 },
  { label: "Dotted 16th", quarterNotes: 0.375 },
  { label: "16th", quarterNotes: 0.25 },
  { label: "32nd", quarterNotes: 0.125 },
  { label: "64th", quarterNotes: 0.0625 }
];

const OUT_OF_TUNE_HIGHLIGHT_COLOR = "#ff4d4d";
// Amber: in the close band (see practice/reviewSummary.ts) -- worth a look, not a mistake.
const CLOSE_HIGHLIGHT_COLOR = "#ffb020";
// Grey rather than the old yellow, which read as "close" next to the amber above.
const NOT_PLAYED_HIGHLIGHT_COLOR = "#9aa0a6";
// Purple: reached but too fast or unclear to measure (verdict "unmeasured").
const UNCLEAR_HIGHLIGHT_COLOR = "#a07ee0";
// Spot practice: how long the player must stop on the loop's last note before the pass ends, and
// how long a graded pass stays on screen before the next one starts listening.
const SPOT_PASS_END_PAUSE_MS = 1200;
const SPOT_NEXT_PASS_DELAY_MS = 1500;
const OFFLINE_SCORING_TIMEOUT_MS = 15_000;

function statusLabel(status: LiveCaptureState["status"]): string {
  switch (status) {
    case "requesting":
      return "Requesting microphone";
    case "calibrating":
      return "Calibrating";
    case "listening":
      return "Listening";
    case "suspended":
      return "Paused";
    case "error":
      return "Error";
    case "idle":
    default:
      return "Idle";
  }
}

export default function App(): ReactElement {
  const controllerRef = useRef<MicrophoneCaptureController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createMicrophoneCaptureController();
  }

  const [captureState, setCaptureState] = useState<LiveCaptureState>(() => controllerRef.current!.getState());
  const [isStarting, setIsStarting] = useState(false);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const [importState, setImportState] = useState<ImportState>("idle");
  const [importResult, setImportResult] = useState<OmrImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const scoreContainerRef = useRef<HTMLDivElement | null>(null);
  // Dev-only toggle: when a measure's parsed duration doesn't match its time signature (usually
  // HOMR missing a mid-piece meter change -- see musicxmlImport.ts's mismatch warning), infer and
  // insert a corrected time signature for that single measure instead of just warning. Off by
  // default -- the inference is ambiguous by nature (see score/timeSignatureInference.ts), so it
  // shouldn't silently relabel every mismatch as a real meter change without opting in. Affects
  // both the next import (ScoreDocument model) and, live, the rendered notation (renderScore
  // effect below depends on this).
  const [autoCorrectTimeSignatures, setAutoCorrectTimeSignatures] = useState(false);

  // OMR/import correction panel (score/correctionUI/noteXmlCorrection.ts) -- "measureIndex:noteIndex"
  // keying a single ScoreNote (see that file's header comment for why notes are addressed this
  // way instead of by ScoreNote.id). Pitch/duration inputs represent "change to" and are left
  // blank/unset by default, meaning "leave unchanged" -- not prefilled with the current value, so
  // applying only touches what the user actually edited.
  const [correctionNoteKey, setCorrectionNoteKey] = useState("");
  const [correctionPitchInput, setCorrectionPitchInput] = useState("");
  const [correctionDurationInput, setCorrectionDurationInput] = useState("");
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  const followerRef = useRef<ScoreFollower | MetronomeScoreFollower | MatchmakerScoreFollower | null>(null);
  const matchmakerStreamRef = useRef<MatchmakerStream | null>(null);
  // The current Matchmaker session's note list and quarter index, for "Jump to bar".
  const sessionNotesRef = useRef<{ notes: CursorNoteInfo[]; quarterIndex: QuarterIndexEntry[] } | null>(null);
  const [jumpBarInput, setJumpBarInput] = useState("");
  // Spot practice (practice/spotPractice.ts): loop bars From-To, one graded pass at a time.
  const [spotEnabled, setSpotEnabled] = useState(false);
  const [spotFromInput, setSpotFromInput] = useState("");
  const [spotToInput, setSpotToInput] = useState("");
  // The region of the session on screen (null for a whole-piece session). State, not just a ref:
  // the summary and the highlights filter by it after the session ends.
  const [activeSpotRegion, setActiveSpotRegion] = useState<SpotRegion | null>(null);
  const [spotPasses, setSpotPasses] = useState<SpotPassResult[]>([]);
  // Keep looping after this pass? Cleared by End Practice, cancelling, or turning spot practice off.
  const spotLoopingRef = useRef(false);
  // The follower whose pass was last recorded. Keyed by follower, not a flag: when the next pass
  // starts, the previous pass's finished state is still on screen until the new follower emits,
  // and a reset flag recorded it a second time.
  const spotRecordedFollowerRef = useRef<object | null>(null);
  const [spotNextPassPending, setSpotNextPassPending] = useState(false);
  // Choosing the loop by tapping bars on the score: first tap picks one bar, a second tap extends
  // to a range, a third starts over.
  const renderedScoreRef = useRef<RenderedScoreHandle | null>(null);
  const [measureBoxes, setMeasureBoxes] = useState<MeasureBox[]>([]);
  const [spotAwaitingEnd, setSpotAwaitingEnd] = useState(false);
  const [jumpMessage, setJumpMessage] = useState<string | null>(null);
  const [scoreCursor, setScoreCursor] = useState<ScoreCursor | null>(null);
  const [followerState, setFollowerState] = useState<ScoreFollowerState | null>(null);
  // "counting_in" is the metronome-mode-only gap between clicking "Practice this score" and the
  // follower actually starting -- see handleStartPracticing()'s count-in handling below. Listening
  // mode never enters this state; it goes straight from "off" to "active".
  const [practiceMode, setPracticeMode] = useState<"off" | "counting_in" | "active">("off");
  // Mirrors practiceMode for the click player's onCountInComplete callback, which fires
  // asynchronously (after a real-time delay) via a plain closure captured when the count-in
  // started -- by the time it fires, that closure's own view of practiceMode is stale (state
  // captured at call time), so it needs a ref to see whether the session was cancelled
  // (End Practice / mic disconnect) in the meantime.
  const practiceModeRef = useRef(practiceMode);
  useEffect(() => {
    practiceModeRef.current = practiceMode;
  }, [practiceMode]);
  // Which mechanism drives cursor advancement during practice. "listening" is the original
  // pitch/onset-driven ScoreFollower; "metronome" is MetronomeScoreFollower
  // (practice/metronomeFollower.ts), which advances purely on a user-chosen tempo; "matchmaker"
  // (practice/matchmakerFollower.ts) delegates the position decision to the Matchmaker library
  // running in the Python server. All three coexist so they can be compared against real playing --
  // the first has never been reliable live, and the third is new and unproven.
  const [trackingMode, setTrackingMode] = useState<"listening" | "metronome" | "matchmaker">("matchmaker");
  const [matchmakerStatus, setMatchmakerStatus] = useState<MatchmakerStreamStatus>("idle");
  // Post-practice scoring: whether the server's alignment has arrived and local scoring begun (the
  // fallback timer stands down once it has), and how far along it is.
  const offlineScoringStartedRef = useRef(false);
  // The most recent Matchmaker take, kept for "Download this take" (practice/takeExport.ts). The
  // history is filled in at download time from the follower's final state.
  const lastTakeRef = useRef<{ take: Omit<SavedTake, "history" | "scoringSource" | "savedAt">; audio: Float32Array } | null>(null);
  const [takeAvailable, setTakeAvailable] = useState(false);
  const [offlineScoringProgress, setOfflineScoringProgress] = useState<number | null>(null);
  const [matchmakerError, setMatchmakerError] = useState<string | null>(null);
  // How the finished take is graded -- see practice/reviewSummary.ts. "own" by default.
  const [gradeReference, setGradeReference] = useState<GradeReference>(DEFAULT_GRADING.reference);
  // Green/amber band widths (practice/reviewSummary.ts STRICTNESS_BANDS). Remembered per browser.
  const [gradeStrictness, setGradeStrictness] = useState<GradeStrictness>(() => {
    try {
      const saved = localStorage.getItem("tunerapp.gradeStrictness");
      return saved === "relaxed" || saved === "strict" ? saved : "standard";
    } catch {
      return "standard";
    }
  });
  const chooseStrictness = (value: GradeStrictness) => {
    setGradeStrictness(value);
    try {
      localStorage.setItem("tunerapp.gradeStrictness", value);
    } catch {
      // Storage unavailable (private window): the choice just won't persist.
    }
  };
  // Live counters shown in the Alignment status line while a Matchmaker session runs, polled
  // rather than pushed: the stream's chunk counter ticks ~30 times a second, and re-rendering the
  // whole app on each one is exactly the kind of main-thread load that starved the socket in an
  // earlier attempt. Polled on a timer so it costs a fixed 4 renders/second regardless.
  const [matchmakerLive, setMatchmakerLive] = useState<{
    gateOpen: boolean;
    chunksSent: number;
    framesAccepted: number;
    framesRejected: number;
    positionsReceived: number;
    lastQuarter: number | null;
    stepIndex: number | null;
    latencyMs: number | null;
  } | null>(null);
  const [metronomeBpm, setMetronomeBpm] = useState(90);
  // Metronome-mode-only: whether the audible click continues for the whole practice session, not
  // just the one-bar count-in before it starts. Off by default -- the count-in itself always
  // plays regardless of this, since it's the "click throughout the piece" part specifically that
  // was requested as an option, not the count-in.
  const [metronomeClickThroughoutEnabled, setMetronomeClickThroughoutEnabled] = useState(false);
  // Metronome-mode-only: see MetronomeFollowerConfig.bowAttackDetectionEnabled's doc comment. Off
  // by default -- the cursor advances strictly on the beat clock's own schedule otherwise, with no
  // dependency on detected pitch/onsets at all.
  const [bowAttackDetectionEnabled, setBowAttackDetectionEnabled] = useState(false);
  // What the audible click ticks on -- "auto" picks a musically conventional default from the
  // score's time signature (plain quarter for simple meters, dotted quarter for compound meters
  // like 6/8, 9/8, 12/8 -- see resolveClickSubdivision() in practice/metronome.ts). A fixed choice
  // overrides that, for a piece phrased differently or a user preference.
  const [clickSubdivision, setClickSubdivision] = useState<ClickSubdivision>("auto");
  const beatClockRef = useRef<BeatClock | null>(null);
  // Synchronous re-entrancy guard for handleStartPracticing() -- a plain `practiceMode !== "off"`
  // check alone isn't reliable here: React state updates aren't visible in a closure until the
  // NEXT render commits, so several rapid clicks landing before that commit (confirmed live under
  // heavy jank -- see handleStartPracticing()'s comment) can all still read the stale "off" value
  // and each construct their own BeatClock/follower. A ref is mutated immediately, with no render
  // in between, so it closes that window even when React's own re-render is delayed.
  const sessionStartingRef = useRef(false);
  // Dev-only toggle for ScoreFollowerConfig.fuzzySequenceMatchingEnabled (see practice/cursor.ts),
  // defaulting off to match the config default. Lets Phase 1 of the resync/onset robustness plan
  // be A/B tested live (via window.__scoreFollower.getTrace()) without editing code -- remove once
  // fuzzy matching has been live-validated and the config default is flipped for real.
  const [fuzzySequenceMatchingEnabled, setFuzzySequenceMatchingEnabled] = useState(false);
  // Dev-only control for ScoreFollowerConfig.fuzzySequenceMaxSkips -- how many CONSECUTIVE missed
  // notes a resync can bridge. Defaults to 1 (the originally-shipped, live-confirmed value);
  // bumping this is what actually extends Phase 1 beyond its known single-note-gap boundary.
  const [fuzzySequenceMaxSkips, setFuzzySequenceMaxSkips] = useState(1);
  // Same dev-only pattern as above, for Phase 2's ScoreFollowerConfig.adaptiveStabilityWindowEnabled.
  // Defaulted on: fast passages can contain notes shorter than the fixed 200ms implicit-hold
  // window, which the implicit trigger structurally cannot catch in time -- this scales that
  // window down per-note based on measured tempo instead.
  const [adaptiveStabilityWindowEnabled, setAdaptiveStabilityWindowEnabled] = useState(true);
  // Same dev-only pattern as above, for Phase 3's ScoreFollowerConfig.energyOnsetFusionEnabled.
  // Defaulted on alongside the above: gives a pending transition extra settle time when the onset
  // that opened it was low-confidence, so a fast run's weaker attacks are less likely to get cut
  // off before a stable reading lands.
  const [energyOnsetFusionEnabled, setEnergyOnsetFusionEnabled] = useState(true);
  // Set by "Practice this score" when the mic isn't listening yet, so practicing can start
  // automatically once calibration finishes instead of requiring a separate manual mic-start
  // step first. Cleared once it fires (or the mic start fails) so a later unrelated mic restart
  // doesn't unexpectedly auto-launch practice.
  const [pendingAutoStartPractice, setPendingAutoStartPractice] = useState(false);
  // Guards highlightNotes() from being called more than once for the same completed/stopped
  // session (followerState updates repeatedly while status stays completed/stopped as long as
  // the mic keeps posting frames). Reset to false at the start of each new practice session.
  const highlightedSessionRef = useRef(false);

  useEffect(() => {
    const controller = controllerRef.current!;
    const unsubscribe = controller.subscribe((state) => {
      setCaptureState(state);
      followerRef.current?.onLiveFrame(state);
    });
    void controller.listInputDevices().then(setInputDevices);

    return () => {
      unsubscribe();
      void controller.stop();
    };
  }, []);

  function handleDeviceChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSelectedDeviceId(event.target.value);
  }

  useEffect(() => {
    if (importState !== "success" || !importResult || !scoreContainerRef.current) {
      return;
    }

    let cancelled = false;
    let handle: RenderedScoreHandle | null = null;
    setRenderError(null);

    renderScore(importResult.xmlData, scoreContainerRef.current, {
      titleOverride: importResult.score.title,
      composerOverride: importResult.score.composer || undefined,
      autoCorrectTimeSignatures
    })
      .then((resolvedHandle) => {
        if (cancelled) {
          resolvedHandle.unmount();
          return;
        }
        handle = resolvedHandle;
        renderedScoreRef.current = resolvedHandle;
        setScoreCursor(resolvedHandle.cursor);
      })
      .catch((err) => {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : "Unknown error while rendering the score.");
        }
      });

    return () => {
      cancelled = true;
      handle?.unmount();
      followerRef.current?.stop();
      followerRef.current = null;
      beatClockRef.current?.stop();
      beatClockRef.current = null;
      matchmakerStreamRef.current?.stop();
      matchmakerStreamRef.current = null;
      sessionStartingRef.current = false;
      setScoreCursor(null);
      setFollowerState(null);
      setPracticeMode("off");
    };
  }, [importState, importResult, autoCorrectTimeSignatures]);

  useEffect(() => {
    if (importResult?.score.tempoBpm) {
      setMetronomeBpm(importResult.score.tempoBpm);
    }
  }, [importResult]);

  useEffect(() => {
    if (trackingMode !== "matchmaker" || practiceMode === "off") {
      setMatchmakerLive(null);
      return;
    }
    const timer = window.setInterval(() => {
      const stream = matchmakerStreamRef.current?.getDiagnostics();
      const follower = followerRef.current instanceof MatchmakerScoreFollower ? followerRef.current.getDiagnostics() : null;
      if (!stream) {
        return;
      }
      setMatchmakerLive({
        gateOpen: stream.gateOpen,
        chunksSent: stream.chunksSent,
        framesAccepted: stream.framesAccepted,
        framesRejected: stream.framesRejected,
        positionsReceived: stream.positionsReceived,
        lastQuarter: stream.lastQuarter,
        stepIndex: follower?.stepIndex ?? null,
        latencyMs: stream.lastLatencyMs
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [trackingMode, practiceMode]);

  useEffect(() => {
    if (practiceMode !== "off" && captureState.status !== "listening") {
      handleStopPracticing();
    }
  }, [captureState.status]);

  useEffect(() => {
    if (!pendingAutoStartPractice) {
      return;
    }
    if (captureState.status === "listening") {
      setPendingAutoStartPractice(false);
      handleStartPracticing();
    } else if (captureState.status === "error") {
      // Mic start failed -- clear the pending flag rather than leaving it armed, or a later
      // unrelated successful mic start would unexpectedly auto-launch practice.
      setPendingAutoStartPractice(false);
    }
  }, [pendingAutoStartPractice, captureState.status]);

  useEffect(() => {
    if (!scoreCursor || !followerState || highlightedSessionRef.current) {
      return;
    }
    if (followerState.status !== "completed" && followerState.status !== "stopped") {
      return;
    }
    highlightedSessionRef.current = true;
    // Natural completion (piece ran out of notes) reaches "off" through THIS effect, not through
    // handleStopPracticing()/handleEndPracticing() -- those only cover the user-initiated/
    // mic-disconnect paths. Without this, a session with "click throughout practice" enabled that
    // finishes on its own left the click playing forever, since nothing else here ever stops it.
    beatClockRef.current?.stop();
    beatClockRef.current = null;
    // Same reasoning for the alignment socket and its mic worklet: a naturally-completed matchmaker
    // session would otherwise keep streaming audio to the server after practice ended.
    matchmakerStreamRef.current?.stop();
    matchmakerStreamRef.current = null;
    setMatchmakerStatus("idle");
    // This is the ONLY place that resets practiceMode to "off" after a session that actually
    // reached "active" (natural completion or End Practice both funnel through here -- see the
    // comment below) -- sessionStartingRef must be cleared here too, or handleStartPracticing()'s
    // re-entrancy guard (see its own doc comment) permanently blocks every future click after the
    // very first session ends, since nothing else would ever clear it for this path.
    sessionStartingRef.current = false;
    // Highlights are drawn by the effect below, so they also redraw when the grading reference
    // changes after the session.
    // Back to "off" now that the session has actually ended (naturally or via End Practice) --
    // this is also what hides the live "Current note"/"Intonation" readout below (gated on
    // practiceMode === "active") and swaps the button back to "Practice this score", so both
    // need this, not just the button.
    setPracticeMode("off");
  }, [followerState, scoreCursor]);

  // Session-end highlights: out of tune red, close amber, not played grey. Re-runs when the
  // grading reference changes, so switching "my tuning"/A440 recolours the score in place.
  useEffect(() => {
    if (!scoreCursor || !followerState) return;
    if (followerState.status !== "completed" && followerState.status !== "stopped") return;
    const summary = summarizePracticeSession(historyInRegion(followerState.history, activeSpotRegion), gradingOptions(gradeReference, gradeStrictness));
    const highlights: NoteHighlight[] = [
      ...summary.unstableNoteIds.map((id) => ({ stepIndex: Number(id), color: OUT_OF_TUNE_HIGHLIGHT_COLOR })),
      ...summary.closeNoteIds.map((id) => ({ stepIndex: Number(id), color: CLOSE_HIGHLIGHT_COLOR })),
      ...summary.notPlayedNoteIds.map((id) => ({ stepIndex: Number(id), color: NOT_PLAYED_HIGHLIGHT_COLOR })),
      ...summary.unmeasuredNoteIds.map((id) => ({ stepIndex: Number(id), color: UNCLEAR_HIGHLIGHT_COLOR }))
    ];
    scoreCursor.highlightNotes(highlights);
  }, [scoreCursor, followerState, gradeReference, gradeStrictness, activeSpotRegion]);

  // A Matchmaker take has ended and its post-practice alignment is on its way. However the follower
  // got here (End Practice, the server reporting the piece finished, the cursor running off the end
  // of the score), stop sending audio but keep the socket open for the result. If it never lands --
  // the server failed, or went quiet -- end on the live estimate rather than waiting forever. The
  // offline pass itself takes well under a second on a short piece (server/offline_check.py), so
  // this only fires on a genuine failure.
  const followerStatus = followerState?.status;
  useEffect(() => {
    if (followerStatus !== "scoring") {
      return;
    }
    matchmakerStreamRef.current?.finish();
    scoreCursor?.hide();
    const timer = window.setTimeout(() => {
      if (!offlineScoringStartedRef.current && followerRef.current instanceof MatchmakerScoreFollower) {
        followerRef.current.finalizeWithoutOffline();
      }
    }, OFFLINE_SCORING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [followerStatus, scoreCursor]);

  // Spot practice: a pass ends when the player goes past the loop, or stops on its last note for a
  // moment (the stream's level gate closing is "stopped"). The take is then graded like any other.
  const spotCurrentStep = followerState?.status === "in_progress" ? followerState.current?.stepIndex ?? null : null;
  // Only once this pass has heard something: before the first note the stream is also "waiting".
  const spotPlayerPaused =
    matchmakerLive !== null && matchmakerLive.chunksSent > 0 && (matchmakerStatus === "waiting_for_sound" || !matchmakerLive.gateOpen);
  useEffect(() => {
    if (!activeSpotRegion || practiceMode !== "active" || spotCurrentStep === null) return;
    if (passIsOver(spotCurrentStep, activeSpotRegion, false)) {
      handleEndPracticing();
      return;
    }
    if (!passIsOver(spotCurrentStep, activeSpotRegion, spotPlayerPaused)) return;
    const timer = window.setTimeout(() => handleEndPracticing(), SPOT_PASS_END_PAUSE_MS);
    return () => window.clearTimeout(timer);
    // handleEndPracticing is recreated every render; the inputs that matter are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpotRegion, practiceMode, spotCurrentStep, spotPlayerPaused]);

  // Record each graded pass once, then start the next one if still looping.
  useEffect(() => {
    const follower = followerRef.current;
    if (!activeSpotRegion || !followerState || !follower || spotRecordedFollowerRef.current === follower) return;
    if (followerState.status !== "completed" && followerState.status !== "stopped") return;
    spotRecordedFollowerRef.current = follower;
    const pass = summarizePass(0, followerState.history, activeSpotRegion, gradingOptions(gradeReference, gradeStrictness));
    // A pass stopped before anything was played isn't a pass.
    if (pass.notPlayed < pass.notes) {
      setSpotPasses((passes) => [...passes, { ...pass, pass: passes.length + 1 }]);
    }
    if (spotLoopingRef.current) setSpotNextPassPending(true);
  }, [activeSpotRegion, followerState, gradeReference, gradeStrictness]);

  useEffect(() => {
    if (!spotNextPassPending || practiceMode !== "off") return;
    // Long enough to see the pass's colours; the next pass then waits for the player to start
    // (the stream sends nothing until it hears playing), with the colours still on the score.
    const timer = window.setTimeout(() => {
      setSpotNextPassPending(false);
      if (spotLoopingRef.current) handleStartPracticing({ keepHighlights: true });
    }, SPOT_NEXT_PASS_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotNextPassPending, practiceMode]);

  function handleStopLooping(): void {
    spotLoopingRef.current = false;
    setSpotNextPassPending(false);
  }

  // Bar boxes for tapping, refreshed whenever they're shown and on resize (OSMD re-lays out).
  const spotSelecting = spotEnabled && practiceMode === "off" && !spotNextPassPending;
  const showSpotBars = spotEnabled && scoreCursor !== null;
  useEffect(() => {
    if (!showSpotBars) {
      setMeasureBoxes([]);
      return;
    }
    const refresh = () => setMeasureBoxes(renderedScoreRef.current?.getMeasureBoxes() ?? []);
    // OSMD's own resize re-render is debounced; measure after it settles.
    let timer = window.setTimeout(refresh, 50);
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 400);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [showSpotBars, scoreCursor]);

  function handleSpotBarTap(measureIndex: number): void {
    const bar = measureIndex + 1;
    const from = Number.parseInt(spotFromInput, 10);
    if (spotAwaitingEnd && Number.isFinite(from)) {
      setSpotFromInput(String(Math.min(from, bar)));
      setSpotToInput(String(Math.max(from, bar)));
      setSpotAwaitingEnd(false);
    } else {
      setSpotFromInput(String(bar));
      setSpotToInput(String(bar));
      setSpotAwaitingEnd(true);
    }
  }

  async function handleStart(): Promise<void> {
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }

    setIsStarting(true);
    try {
      await controller.start({
        ...LIVE_CAPTURE_OPTIONS,
        deviceId: selectedDeviceId || undefined,
        // Fixed at mic-start time like every other capture option here -- toggling the checkbox
        // after the mic is already running requires a stop/start to take effect.
        energyOnsetDetectionEnabled: energyOnsetFusionEnabled
      });
      const devices = await controller.listInputDevices();
      setInputDevices(devices);
    } catch {
      // The controller already reflects the error state for the UI.
    } finally {
      setIsStarting(false);
    }
  }

  async function handlePause(): Promise<void> {
    await controllerRef.current?.pause();
  }

  async function handleStop(): Promise<void> {
    await controllerRef.current?.stop();
  }

  // If the mic isn't listening yet, kick off a start and let the pendingAutoStartPractice effect
  // above call handleStartPracticing() once calibration actually reaches "listening" -- starting
  // the follower immediately would just fail the status check below and do nothing.
  function handleRequestStartPracticing(): void {
    if (captureState.status === "listening") {
      handleStartPracticing();
      return;
    }
    setPendingAutoStartPractice(true);
    void handleStart();
  }

  // Actually constructs and starts the follower -- split out from handleStartPracticing() so
  // metronome mode can defer this until the count-in bar actually finishes, while listening mode
  // (no count-in) can call it immediately.
  function beginFollowing(): void {
    if (!scoreCursor) {
      return;
    }
    const follower: ScoreFollower | MetronomeScoreFollower | MatchmakerScoreFollower =
      trackingMode === "metronome"
        ? new MetronomeScoreFollower(scoreCursor, { ...DEFAULT_METRONOME_FOLLOWER_CONFIG, bowAttackDetectionEnabled })
        : trackingMode === "matchmaker"
          ? new MatchmakerScoreFollower(scoreCursor)
          : new ScoreFollower(scoreCursor, {
              fuzzySequenceMatchingEnabled,
              fuzzySequenceMaxSkips,
              adaptiveStabilityWindowEnabled,
              energyOnsetFusionEnabled
            });
    followerRef.current = follower;
    follower.subscribe(setFollowerState);
    follower.start();
    scoreCursor.show();
    setPracticeMode("active");

    // TEMPORARY debug hook for live diagnosis -- run `__scoreFollower.getTrace()` (listening and
    // matchmaker modes; the metronome follower has nothing to trace) in the browser console after a
    // practice session. Remove once tracking is validated against real playing.
    (window as unknown as { __scoreFollower?: typeof follower }).__scoreFollower = follower;
  }

  // Matchmaker mode's own startup: opens the alignment socket and starts streaming mic audio to it.
  // Kept out of beginFollowing() because the server needs seconds to synthesize the score's
  // reference audio before it can align anything -- the follower only starts once that's done, so
  // the cursor doesn't sit on the first note pretending to track while nothing is listening yet.
  async function startMatchmakerSession(): Promise<void> {
    const mediaStream = controllerRef.current?.getMediaStream();
    if (!scoreCursor || !mediaStream || !importResult) {
      sessionStartingRef.current = false;
      return;
    }

    const stream = new MatchmakerStream();
    matchmakerStreamRef.current = stream;
    setMatchmakerError(null);
    // Reuses metronome mode's pre-session state so the button becomes a cancel affordance while the
    // server prepares the score, rather than looking idle and clickable for several seconds.
    setPracticeMode("counting_in");

    offlineScoringStartedRef.current = false;
    setOfflineScoringProgress(null);
    lastTakeRef.current = null;
    setTakeAvailable(false);

    // Snapshot of how the live tuner is detecting pitch right now, so the post-practice pass runs
    // the detector exactly the same way over the recording (see OfflineDetectorSetup).
    const liveGainScalar = captureState.gainScalar;
    const liveSilenceRmsThreshold = captureState.silenceRmsThreshold;
    // Walked before the follower starts: both reset the cursor, which must not happen mid-session.
    // A throw here (an OSMD cursor crash on an unusual OMR score did exactly this) used to escape
    // the async handler and leave the page on "Preparing score…" forever; fail visibly instead.
    let scoreNotes: ReturnType<typeof scoreCursor.listNotes>;
    let scoreQuarterIndex: ReturnType<typeof scoreCursor.buildQuarterIndex>;
    try {
      scoreNotes = scoreCursor.listNotes();
      scoreQuarterIndex = scoreCursor.buildQuarterIndex();
      sessionNotesRef.current = { notes: scoreNotes, quarterIndex: scoreQuarterIndex };
      setJumpBarInput("");
      setJumpMessage(null);
    } catch (error) {
      console.error("Could not read the score's notes for score following", error);
      setMatchmakerError(
        `Couldn't read this score's notes (${error instanceof Error ? error.message : String(error)}). Try another file, or use metronome mode.`
      );
      matchmakerStreamRef.current = null;
      sessionStartingRef.current = false;
      setPracticeMode("off");
      return;
    }
    let spotRegion: SpotRegion | null = null;
    if (spotEnabled) {
      const resolved = resolveSpotRegion(scoreNotes, scoreQuarterIndex, Number.parseInt(spotFromInput, 10), Number.parseInt(spotToInput, 10));
      if (typeof resolved === "string") {
        setMatchmakerError(resolved);
        matchmakerStreamRef.current = null;
        sessionStartingRef.current = false;
        spotLoopingRef.current = false;
        setPracticeMode("off");
        return;
      }
      spotRegion = resolved;
      // A different passage starts a fresh pass history.
      setActiveSpotRegion((previous) => {
        if (!previous || previous.firstStepIndex !== resolved.firstStepIndex || previous.lastStepIndex !== resolved.lastStepIndex) {
          setSpotPasses([]);
        }
        return resolved;
      });
      spotLoopingRef.current = true;
    } else {
      setActiveSpotRegion(null);
      setSpotPasses([]);
      spotLoopingRef.current = false;
    }
    let offlinePathReceived = false;

    const scoreOffline = async (path: AlignmentPoint[]): Promise<void> => {
      offlinePathReceived = true;
      // The fallback timer only covers waiting for the server's reply. From here the work is local
      // and runs to completion -- it takes a fraction of the take's own length, which for a long
      // take can exceed the timer, and must not be discarded halfway.
      offlineScoringStartedRef.current = true;
      setOfflineScoringProgress(0);
      const follower = followerRef.current;
      if (!(follower instanceof MatchmakerScoreFollower)) {
        return;
      }
      const sampleRate = stream.getDiagnostics().sampleRate ?? 48_000;
      const recordedAudio = stream.getRecordedAudio();
      const detectorSetup = {
            sampleRate,
            gainScalar: liveGainScalar,
            silenceRmsThreshold: liveSilenceRmsThreshold,
            frameSize: analysisFrameSizeFor(sampleRate, LIVE_CAPTURE_OPTIONS.frameSize ?? 2048),
            // Sparser than live and without the per-frame smoother -- see the constants' comments.
            hopSize: Math.round(sampleRate * OFFLINE_ANALYSIS_INTERVAL_SECONDS),
            confidenceThreshold: LIVE_CAPTURE_OPTIONS.confidenceThreshold ?? 0.67,
            lowCutHz: LIVE_CAPTURE_OPTIONS.lowCutHz ?? 80,
            highCutHz: LIVE_CAPTURE_OPTIONS.highCutHz ?? 3500,
            smoothingWindowFrames: OFFLINE_SMOOTHING_FRAMES
          };
      const scoringConfig = {
            inTuneCentsThreshold: DEFAULT_MATCHMAKER_FOLLOWER_CONFIG.inTuneCentsThreshold,
            minSamplesForVerdict: DEFAULT_MATCHMAKER_FOLLOWER_CONFIG.minSamplesForVerdict,
            settleMs: DEFAULT_MATCHMAKER_FOLLOWER_CONFIG.onsetSettleMs,
            plausibilityHighConfidenceThreshold: DEFAULT_MATCHMAKER_FOLLOWER_CONFIG.plausibilityHighConfidenceThreshold,
            plausibilityLowConfidenceCentsLimit: DEFAULT_MATCHMAKER_FOLLOWER_CONFIG.plausibilityLowConfidenceCentsLimit,
            plausibilityAbsoluteCentsLimit: DEFAULT_MATCHMAKER_FOLLOWER_CONFIG.plausibilityAbsoluteCentsLimit
          };
      lastTakeRef.current = {
        take: { format: "tunerapp-take", version: 1, sampleRate, scoreXml: importResult.xmlData, path, notes: scoreNotes, quarterIndex: scoreQuarterIndex, detectorSetup, scoringConfig },
        audio: recordedAudio
      };
      setTakeAvailable(true);
      try {
        const records = await scoreRecordingOffline(
          recordedAudio,
          path,
          scoreNotes,
          scoreQuarterIndex,
          detectorSetup,
          scoringConfig,
          (fraction) => setOfflineScoringProgress(fraction)
        );
        if (records.length > 0) {
          follower.applyOfflineHistory(records);
        } else {
          follower.finalizeWithoutOffline();
        }
      } catch (error) {
        console.error("[matchmaker] post-practice scoring failed", error);
        follower.finalizeWithoutOffline();
      }
    };

    try {
      await stream.start(mediaStream, importResult.xmlData, {
        onStatus: setMatchmakerStatus,
        onPosition: (quarter) => {
          if (followerRef.current instanceof MatchmakerScoreFollower) {
            followerRef.current.onQuarterPosition(quarter);
          }
        },
        onCompleted: () => {
          if (followerRef.current instanceof MatchmakerScoreFollower) {
            followerRef.current.complete();
          }
        },
        onError: (message) => {
          setMatchmakerError(message);
          if (followerRef.current instanceof MatchmakerScoreFollower) {
            followerRef.current.stop();
          }
        },
        onOfflineAlignment: (path) => {
          void scoreOffline(path);
        },
        onClosed: () => {
          // The server closes right after sending the offline alignment, so a close is only a
          // failure signal when no alignment arrived first.
          if (!offlinePathReceived && followerRef.current instanceof MatchmakerScoreFollower) {
            followerRef.current.finalizeWithoutOffline();
          }
        }
      }, {
        // The capture module's calibrated noise-floor threshold, measured on the same raw signal
        // the alignment stream carries -- see MatchmakerStreamOptions.silenceRmsThreshold.
        silenceRmsThreshold: captureState.silenceRmsThreshold
      });
    } catch (error) {
      setMatchmakerError(error instanceof Error ? error.message : "Could not start alignment.");
      matchmakerStreamRef.current = null;
      sessionStartingRef.current = false;
      setPracticeMode("off");
      return;
    }

    // The user may have backed out during the (multi-second) score preparation above.
    if (!sessionStartingRef.current) {
      stream.stop();
      matchmakerStreamRef.current = null;
      return;
    }
    beginFollowing();
    if (spotRegion && followerRef.current instanceof MatchmakerScoreFollower) {
      // Every pass starts at the loop's first note: the same jump "Jump to bar" makes, sent before
      // any audio, so both the live follower and the post-take alignment start there.
      stream.seek(spotRegion.fromQuarter);
      followerRef.current.jumpToQuarter(spotRegion.fromQuarter);
    }
  }

  // "Jump to bar": when one bar stops tracking (often an OMR misread), the player moves on and
  // tells the app where they are. The server aligns the take before and after the jump
  // separately; notes jumped over are reported as not played.
  function handleJumpToBar(): void {
    const follower = followerRef.current;
    const stream = matchmakerStreamRef.current;
    const session = sessionNotesRef.current;
    const bar = Number.parseInt(jumpBarInput, 10);
    if (!(follower instanceof MatchmakerScoreFollower) || !stream || !session || !Number.isFinite(bar)) {
      return;
    }
    // The first note in that bar (or the first after it, if the bar has no notes of its own).
    const entry = [...session.quarterIndex]
      .sort((a, b) => a.quarter - b.quarter)
      .find((candidate) => (session.notes[candidate.stepIndex]?.measureIndex ?? -1) + 1 >= bar);
    if (!entry) {
      setJumpMessage(`There's no bar ${bar} with notes in this score.`);
      return;
    }
    if (!stream.seek(entry.quarter)) {
      setJumpMessage("The alignment server isn't connected, so the jump can't be recorded.");
      return;
    }
    follower.jumpToQuarter(entry.quarter);
    const landedBar = (session.notes[entry.stepIndex]?.measureIndex ?? 0) + 1;
    setJumpMessage(landedBar === bar ? `Jumped to bar ${bar}. Play from there.` : `Bar ${bar} has no notes; jumped to bar ${landedBar}.`);
  }

  function handleStartPracticing(options: { keepHighlights?: boolean } = {}): void {
    // Without this, clicking "Practice this score" more than once while a session is already
    // counting in or active (e.g. a few impatient clicks before the button visibly swaps to
    // "Counting in… (cancel)") creates ANOTHER BeatClock -- its own AudioContext, setInterval
    // scheduler, and eventual MetronomeScoreFollower -- on top of the one already running, since
    // nothing here or in beginFollowing() ever stopped the previous one first. Confirmed live: a
    // handful of rapid clicks produced several concurrent clocks/followers all independently
    // advancing the SAME shared ScoreCursor, which is exactly what showed up as severe lag
    // (browser "setTimeout handler took Nms" violations from Nx the scheduling work), the audible
    // click glitching, and the visible cursor freezing/jumping (several independent
    // advanceToNextNote() calls racing on one mutable OSMD cursor object). Checking BOTH
    // practiceMode and sessionStartingRef -- see the ref's own doc comment for why the state check
    // alone wasn't sufficient under real jank.
    if (practiceMode !== "off" || sessionStartingRef.current) {
      return;
    }
    if (!scoreCursor || captureState.status !== "listening") {
      return;
    }
    sessionStartingRef.current = true;

    highlightedSessionRef.current = false;
    // Clear any red/yellow highlights left over from a previous session -- otherwise they'd sit
    // on the score, misrepresenting THIS session, since highlightNotes() only runs again at the
    // end of this new one. Spot practice's next pass keeps them: the player is looking at what to
    // fix while playing the same bars again.
    if (!options.keepHighlights) {
      scoreCursor.highlightNotes([]);
    }

    if (trackingMode === "matchmaker") {
      // Deferred like metronome mode's count-in, but waiting on the server preparing the score
      // rather than on a bar of clicks. sessionStartingRef stays set across the await so a second
      // click during preparation is still rejected by the guard above.
      void startMatchmakerSession();
      return;
    }

    if (trackingMode !== "metronome") {
      // No count-in outside metronome mode -- ScoreFollower doesn't have (or need) a fixed tempo
      // to count in against.
      beginFollowing();
      return;
    }

    setPracticeMode("counting_in");
    const bpm = Math.min(300, Math.max(20, metronomeBpm || 90));
    // TEMPORARY diagnostic alongside the matching one in metronome.ts -- confirms the full
    // per-measure meter sequence the clock is actually working from, not just the piece's opening
    // signature. Remove once mid-piece meter changes are confirmed working live.
    const timeSignatureSegments = computeTimeSignatureSegments(importResult?.score.measures ?? []);
    console.debug(`[metronome] timeSignatureSegments: ${JSON.stringify(timeSignatureSegments)}`);
    const beatClock = createBeatClock({ tempoBpm: bpm, timeSignatureSegments, clickSubdivision });
    beatClockRef.current = beatClock;
    beatClock.start({
      continueClicking: metronomeClickThroughoutEnabled,
      onCountInComplete: () => {
        // The count-in itself may have been cancelled (End Practice / mic disconnect) before this
        // fires -- only actually start the follower if we're still waiting on it.
        if (practiceModeRef.current === "counting_in") {
          beginFollowing();
        }
      },
      // The metronome's own click plays through speakers, which the microphone can pick up as a
      // clean, confidently-detected tone -- indistinguishable from a real note by pitch/confidence
      // alone. Since we're the ones scheduling it, mask it out directly instead.
      onClick: () => {
        if (followerRef.current instanceof MetronomeScoreFollower) {
          followerRef.current.notifyClickPlayed();
        }
      },
      // The SAME scheduled event that (optionally) produces the audible click also advances the
      // cursor here -- see BeatClockOptions.onTick's doc comment in practice/metronome.ts for why
      // this replaced the old frame-timestamp-driven approach. followerRef.current is guaranteed
      // set by the time any tick fires: onCountInComplete (which synchronously calls
      // beginFollowing()) always runs before the first tick that could call this, from within the
      // same beat-clock callback.
      onTick: (quarterNotesElapsed) => {
        if (followerRef.current instanceof MetronomeScoreFollower) {
          followerRef.current.advanceOnTick(quarterNotesElapsed);
        }
      }
    });
  }

  // Cancels the count-in specifically -- unlike handleStopPracticing()/handleEndPracticing(),
  // there is no follower yet to stop (beginFollowing() hasn't run), and practiceMode needs to go
  // straight back to "off" rather than staying at whatever handleEndPracticing's "leave it active
  // for the summary" convention would otherwise imply (there's no session/summary to show for a
  // count-in that never became a real practice attempt).
  function handleCancelCountIn(): void {
    handleStopLooping();
    beatClockRef.current?.stop();
    beatClockRef.current = null;
    stopMatchmakerStream();
    sessionStartingRef.current = false;
    setPracticeMode("off");
  }

  function handleStopPracticing(): void {
    handleStopLooping();
    followerRef.current?.stop();
    // This path abandons the session outright (mic lost) and hard-stops the stream below, so no
    // post-practice result is coming -- end on the live estimate instead of waiting out the timeout.
    if (followerRef.current instanceof MatchmakerScoreFollower) {
      followerRef.current.finalizeWithoutOffline();
    }
    beatClockRef.current?.stop();
    beatClockRef.current = null;
    stopMatchmakerStream();
    sessionStartingRef.current = false;
    scoreCursor?.hide();
    setPracticeMode("off");
  }

  function stopMatchmakerStream(): void {
    matchmakerStreamRef.current?.stop();
    matchmakerStreamRef.current = null;
    setMatchmakerStatus("idle");
  }

  // User-initiated "End Practice" -- finalizes the in-progress note and shows the same
  // completion summary/highlighting a naturally-finished piece gets (see the followerState.status
  // "stopped" checks below), rather than silently abandoning the session like
  // handleStopPracticing() (still used as-is by the automatic mic-disconnect safety net above,
  // where popping up a summary doesn't make sense). Deliberately leaves practiceMode "active",
  // matching how natural completion already behaves -- "Practice again" is the only way back in,
  // same as today.
  function handleEndPracticing(): void {
    followerRef.current?.stop();
    beatClockRef.current?.stop();
    beatClockRef.current = null;
    // Not stopMatchmakerStream(): a Matchmaker take ends gracefully so the server can still send
    // back its post-practice alignment (the follower is now "scoring"; see the effect watching it).
    // Other modes have no stream, and this is a no-op for them.
    matchmakerStreamRef.current?.finish();
    scoreCursor?.hide();
  }

  function handleDownloadMusicXml(): void {
    if (!importResult) {
      return;
    }

    const blob = new Blob([importResult.xmlData], { type: "application/vnd.recordare.musicxml+xml" });
    const url = URL.createObjectURL(blob);
    const fileNameSafeTitle = importResult.score.title.replace(/[^a-z0-9-_]+/gi, "_") || "sheet-music";

    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileNameSafeTitle}.musicxml`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function handleSheetFileSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setImportState("loading");
    setImportError(null);
    setImportResult(null);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importPhotoToScore(bytes, { autoCorrectTimeSignatures });
      setImportResult(result);
      setImportState("success");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Unknown error while importing sheet music.");
      setImportState("error");
    }
  }

  // Bypasses HOMR entirely -- useful for isolating the live tuner/score-following pipeline from
  // OMR pitch-recognition accuracy when testing.
  async function handleMusicXmlFileSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setImportState("loading");
    setImportError(null);
    setImportResult(null);

    try {
      const xmlData = await file.text();
      const score = await importMusicXmlToScore(xmlData, { autoCorrectTimeSignatures });
      setImportResult({ score, transientBoundingBoxes: [], xmlData });
      setImportState("success");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Unknown error while importing the MusicXML file.");
      setImportState("error");
    }
  }

  const correctableNotes = importResult
    ? importResult.score.measures.flatMap((measure, measureIndex) =>
        measure.notes.map((note, noteIndex) => ({ measureIndex, noteIndex, note }))
      )
    : [];

  function handleApplyNoteCorrection(): void {
    if (!importResult) {
      return;
    }
    setCorrectionError(null);

    const [measureIndexText, noteIndexText] = correctionNoteKey.split(":");
    const measureIndex = Number.parseInt(measureIndexText ?? "", 10);
    const noteIndex = Number.parseInt(noteIndexText ?? "", 10);
    if (!Number.isFinite(measureIndex) || !Number.isFinite(noteIndex)) {
      setCorrectionError("Choose a note to correct first.");
      return;
    }

    const trimmedPitch = correctionPitchInput.trim();
    if (trimmedPitch && !/^[A-G](#|b)?\d{1,2}$/.test(trimmedPitch)) {
      setCorrectionError("Pitch must look like C4, F#3, or Bb5.");
      return;
    }
    const durationBeats = correctionDurationInput ? Number.parseFloat(correctionDurationInput) : null;
    if (!trimmedPitch && durationBeats === null) {
      setCorrectionError("Enter a corrected pitch and/or pick a corrected duration first.");
      return;
    }

    const correctedXml = applyNoteCorrectionsToXml(importResult.xmlData, [
      {
        measureIndex,
        noteIndexInMeasure: noteIndex,
        pitch: trimmedPitch || undefined,
        durationBeats: durationBeats ?? undefined
      }
    ]);

    importMusicXmlToScore(correctedXml, { autoCorrectTimeSignatures })
      .then((score) => {
        setImportResult({
          ...importResult,
          score: { ...score, sourceType: importResult.score.sourceType },
          xmlData: correctedXml
        });
        setCorrectionPitchInput("");
        setCorrectionDurationInput("");
      })
      .catch((err) => {
        setCorrectionError(err instanceof Error ? err.message : "Could not apply that correction.");
      });
  }

  const noteDisplay = captureState.isSilent || captureState.frequencyHz === null ? "No note" : captureState.note ?? "--";
  const pitchClass = captureState.isSilent ? "idle" : captureState.note ? "active" : "searching";
  const levelRatio = captureState.silenceRmsThreshold > 0 ? Math.min(1, captureState.rms / captureState.silenceRmsThreshold) : 0;

  const liveCentsFromExpected = followerState?.liveCentsOffFromExpected ?? null;
  const isInTune = liveCentsFromExpected !== null && Math.abs(liveCentsFromExpected) <= DEFAULT_SCORE_FOLLOWER_CONFIG.inTuneCentsThreshold;
  const intonationLabel = liveCentsFromExpected === null ? "Listening…" : isInTune ? "In tune" : "Off pitch";
  const intonationColor = liveCentsFromExpected === null ? "#f5f7fb" : isInTune ? "#8ee8cb" : "#ff8a8a";
  const sessionSummary = summarizePracticeSession(historyInRegion(followerState?.history ?? [], activeSpotRegion), gradingOptions(gradeReference, gradeStrictness));
  // Read on render rather than mirrored into state: every change to it coincides with a follower
  // emit, which already re-renders.
  const finalScoringSource =
    followerRef.current instanceof MatchmakerScoreFollower ? followerRef.current.getScoringSource() : null;

  return (
    <div style={styles.page}>
      <style>{`
        :root {
          color-scheme: dark;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background:
            radial-gradient(circle at top left, rgba(107, 205, 170, 0.16), transparent 30%),
            radial-gradient(circle at right center, rgba(55, 121, 255, 0.18), transparent 26%),
            linear-gradient(180deg, #07111f 0%, #091725 42%, #050b14 100%);
          color: #f5f7fb;
        }

        button {
          font: inherit;
        }
      `}</style>

      <main style={styles.shell}>
        <section style={styles.heroCard}>
          <div style={styles.topRow}>
            <div>
              <p style={styles.kicker}>Live violin tuner</p>
              <h1 style={styles.title}>TunerApp</h1>
            </div>
            <span style={{ ...styles.statusPill, ...statusStyles[captureState.status] }}>{statusLabel(captureState.status)}</span>
          </div>

          <div style={styles.readoutGrid}>
            <div style={styles.readoutCard}>
              <div style={styles.readoutLabel}>Note</div>
              <div style={styles.readoutValueLarge} data-state={pitchClass}>
                {noteDisplay}
              </div>
            </div>
            <div style={styles.readoutCard}>
              <div style={styles.readoutLabel}>Frequency</div>
              <div style={styles.readoutValue}>{formatFrequency(captureState.frequencyHz)}</div>
            </div>
            <div style={styles.readoutCard}>
              <div style={styles.readoutLabel}>Cents off</div>
              <div style={styles.readoutValue}>{formatCents(captureState.centsOff)}</div>
            </div>
            <div style={styles.readoutCard}>
              <div style={styles.readoutLabel}>Confidence</div>
              <div style={styles.readoutValue}>{formatConfidence(captureState.confidence)}</div>
            </div>
          </div>

          <div style={styles.diagnosticsGrid}>
            <div style={styles.diagnosticCard}>
              <div style={styles.readoutLabel}>Live RMS</div>
              <div style={styles.readoutValue}>{captureState.rms.toFixed(4)}</div>
              <div style={styles.meterTrack} aria-hidden="true">
                <div style={{ ...styles.meterFill, width: `${Math.max(6, levelRatio * 100)}%` }} />
              </div>
              <div style={styles.diagnosticHint}>{captureState.isSilent ? "Silence floor" : "Bow energy detected"}</div>
            </div>
            <div style={styles.diagnosticCard}>
              <div style={styles.readoutLabel}>Target threshold</div>
              <div style={styles.readoutValue}>{captureState.silenceRmsThreshold.toFixed(4)}</div>
              <div style={styles.diagnosticHint}>Auto-calibrated from startup noise</div>
            </div>
            <div style={styles.diagnosticCard}>
              <div style={styles.readoutLabel}>Gain</div>
              <div style={styles.readoutValue}>{captureState.gainScalar.toFixed(1)}x Boost</div>
              <div style={styles.diagnosticHint}>Software gain for weak microphones</div>
            </div>
          </div>

          <div style={styles.metaRow}>
            <div>
              <div style={styles.metaLabel}>Sample rate</div>
              <div style={styles.metaValue}>{captureState.sampleRate > 0 ? `${captureState.sampleRate} Hz` : "--"}</div>
            </div>
            <div>
              <div style={styles.metaLabel}>Noise gate</div>
              <div style={styles.metaValue}>{captureState.isSilent ? "Silent" : `RMS ${captureState.rms.toFixed(4)}`}</div>
            </div>
            <div>
              <div style={styles.metaLabel}>Frame</div>
              <div style={styles.metaValue}>{captureState.frameSize} / {captureState.hopSize}</div>
            </div>
          </div>

          <div style={styles.metaRow}>
            <div>
              <div style={styles.metaLabel}>Active microphone</div>
              <div style={styles.metaValue}>{captureState.activeDeviceLabel ?? "--"}</div>
            </div>
          </div>

          <label style={styles.deviceLabel}>
            Microphone
            <select
              value={selectedDeviceId}
              onChange={handleDeviceChange}
              style={styles.deviceSelect}
              disabled={captureState.status === "listening" || captureState.status === "calibrating"}
            >
              <option value="">System default</option>
              {inputDevices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          {captureState.error ? <div style={styles.errorBox}>{captureState.error.message}</div> : null}

          <div style={styles.buttonRow}>
            <button type="button" style={styles.primaryButton} onClick={handleStart} disabled={isStarting || captureState.status === "requesting"}>
              {isStarting || captureState.status === "requesting" ? "Starting..." : "Start Microphone"}
            </button>
            <button type="button" style={styles.secondaryButton} onClick={handlePause} disabled={captureState.status !== "listening"}>
              Pause
            </button>
            <button type="button" style={styles.secondaryButton} onClick={handleStop} disabled={captureState.status === "idle"}>
              Stop
            </button>
          </div>

          <p style={styles.caption}>
            Microphone processing is configured for violin acoustics with echo cancellation, noise suppression, and automatic gain control disabled.
          </p>
        </section>

        <section style={styles.importCard}>
          <div style={styles.topRow}>
            <div>
              <p style={styles.kicker}>Sheet music import</p>
              <h2 style={styles.subtitle}>Upload a photo</h2>
            </div>
            {importState === "loading" ? <span style={{ ...styles.statusPill, ...statusStyles.calibrating }}>Parsing sheet…</span> : null}
          </div>

          <div style={styles.buttonRow}>
            <label style={styles.secondaryButton}>
              Choose sheet music photo
              <input type="file" accept="image/*" onChange={handleSheetFileSelected} style={styles.hiddenFileInput} />
            </label>
            <label style={styles.secondaryButton}>
              Choose MusicXML file
              <input
                type="file"
                accept=".xml,.musicxml,application/vnd.recordare.musicxml+xml,text/xml,application/xml"
                onChange={handleMusicXmlFileSelected}
                style={styles.hiddenFileInput}
              />
            </label>
          </div>

          <label style={styles.diagnosticHint}>
            <input
              type="checkbox"
              checked={autoCorrectTimeSignatures}
              onChange={(event) => setAutoCorrectTimeSignatures(event.target.checked)}
            />{" "}
            Dev: auto-correct time signatures (when a bar's parsed beats don't match its time
            signature -- usually a missed mid-piece meter change -- infer and insert a corrected
            one for that bar, off by default; see score/timeSignatureInference.ts)
          </label>

          {importState === "error" && importError ? <div style={styles.errorBox}>{importError}</div> : null}

          {importState === "success" && importResult ? (
            <div style={styles.importResult}>
              <div style={styles.metaRow}>
                <div>
                  <div style={styles.metaLabel}>Title</div>
                  <div style={styles.metaValue}>
                    {importResult.score.title}
                    {importResult.score.composer ? ` — ${importResult.score.composer}` : ""}
                  </div>
                </div>
                <div>
                  <div style={styles.metaLabel}>Tempo</div>
                  <div style={styles.metaValue}>{formatTempo(importResult.score.tempoBpm)}</div>
                </div>
                <div>
                  <div style={styles.metaLabel}>Key / Time</div>
                  <div style={styles.metaValue}>
                    {importResult.score.keySignature} · {importResult.score.timeSignature}
                  </div>
                </div>
              </div>

              <p style={styles.diagnosticHint}>
                {importResult.score.measures.reduce((total, measure) => total + measure.notes.length, 0)} notes detected across{" "}
                {importResult.score.measures.length} measures.
              </p>
              {importResult.score.measureIssues && importResult.score.measureIssues.length > 0 ? (
                <p style={{ ...styles.diagnosticHint, color: "#ffb020" }}>
                  {importResult.score.measureIssues.length === 1 ? "1 bar doesn't" : `${importResult.score.measureIssues.length} bars don't`}{" "}
                  add up to the time signature, which usually means a note was misread:{" "}
                  {importResult.score.measureIssues
                    .slice(0, 10)
                    .map((issue) => `bar ${issue.measureNumber} (${issue.kind === "empty" ? "empty" : issue.kind === "short" ? "too short" : "too long"})`)
                    .join(", ")}
                  {importResult.score.measureIssues.length > 10 ? ", …" : ""}. Following can stall there: fix the note with
                  "Fix a misread note" below, or use "Jump to bar" during practice to skip past it.
                </p>
              ) : null}

              <div style={styles.buttonRow}>
                <button type="button" style={styles.secondaryButton} onClick={handleDownloadMusicXml}>
                  Download MusicXML
                </button>
                {practiceMode === "active" ? (
                  <button
                    type="button"
                    style={styles.secondaryButton}
                    onClick={() => {
                      handleStopLooping();
                      handleEndPracticing();
                    }}
                  >
                    {activeSpotRegion ? "Stop looping" : "End Practice"}
                  </button>
                ) : null}
                {practiceMode === "active" && trackingMode === "matchmaker" && followerState?.status === "in_progress" ? (
                  <form
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      handleJumpToBar();
                    }}
                  >
                    <label style={styles.diagnosticHint} htmlFor="jump-bar">
                      Stuck? Jump to bar
                    </label>
                    <input
                      id="jump-bar"
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={jumpBarInput}
                      onChange={(event) => setJumpBarInput(event.target.value)}
                      style={{ width: 64 }}
                    />
                    <button type="submit" style={styles.secondaryButton} disabled={!jumpBarInput}>
                      Go
                    </button>
                  </form>
                ) : null}
                {practiceMode === "active" ? null : practiceMode === "counting_in" ? (
                  <button type="button" style={styles.secondaryButton} onClick={handleCancelCountIn}>
                    {trackingMode === "matchmaker" ? "Preparing score… (cancel)" : "Counting in… (cancel)"}
                  </button>
                ) : (
                  <button
                    type="button"
                    style={styles.secondaryButton}
                    onClick={handleRequestStartPracticing}
                    disabled={!scoreCursor || isStarting || pendingAutoStartPractice}
                  >
                    {pendingAutoStartPractice || isStarting ? "Starting microphone…" : "Practice this score"}
                  </button>
                )}
              </div>

              {practiceMode === "off" && correctableNotes.length > 0 ? (
                <div style={styles.correctionPanel}>
                  <p style={styles.metaLabel}>Fix a misread note</p>
                  <div style={styles.correctionRow}>
                    <select
                      value={correctionNoteKey || `${correctableNotes[0].measureIndex}:${correctableNotes[0].noteIndex}`}
                      onChange={(event) => setCorrectionNoteKey(event.target.value)}
                    >
                      {correctableNotes.map(({ measureIndex, noteIndex, note }) => (
                        <option key={`${measureIndex}:${noteIndex}`} value={`${measureIndex}:${noteIndex}`}>
                          Measure {measureIndex + 1}, note {noteIndex + 1} — currently {note.pitch}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Corrected pitch (e.g. C#4)"
                      value={correctionPitchInput}
                      onChange={(event) => setCorrectionPitchInput(event.target.value)}
                      style={{ width: "10em" }}
                    />
                    <select value={correctionDurationInput} onChange={(event) => setCorrectionDurationInput(event.target.value)}>
                      <option value="">Don't change duration</option>
                      {CORRECTION_DURATION_OPTIONS.map((option) => (
                        <option key={option.label} value={option.quarterNotes}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button type="button" style={styles.secondaryButton} onClick={handleApplyNoteCorrection}>
                      Apply
                    </button>
                  </div>
                  <p style={styles.diagnosticHint}>
                    Fixes what OMR misread on a single note (pitch and/or duration) — not a full notation editor. Pick the
                    note, enter what it should be, and leave the other field blank to keep it as-is.
                  </p>
                  {correctionError ? <div style={styles.errorBox}>{correctionError}</div> : null}
                </div>
              ) : null}

              {practiceMode === "off" ? (
                <div style={styles.diagnosticHint}>
                  Tracking mode:{" "}
                  <label>
                    <input
                      type="radio"
                      name="trackingMode"
                      checked={trackingMode === "listening"}
                      onChange={() => setTrackingMode("listening")}
                    />{" "}
                    Listening (pitch/onset-driven)
                  </label>{" "}
                  <label>
                    <input
                      type="radio"
                      name="trackingMode"
                      checked={trackingMode === "matchmaker"}
                      onChange={() => setTrackingMode("matchmaker")}
                    />{" "}
                    Matchmaker (alignment server, recommended)
                  </label>{" "}
                  <label>
                    <input
                      type="radio"
                      name="trackingMode"
                      checked={trackingMode === "metronome"}
                      onChange={() => setTrackingMode("metronome")}
                    />{" "}
                    Metronome (tempo-driven, no pitch tracking)
                  </label>
                </div>
              ) : null}

              {trackingMode === "matchmaker" && practiceMode === "off" && !spotNextPassPending ? (
                <div style={{ ...styles.diagnosticHint, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <label>
                    <input
                      type="checkbox"
                      checked={spotEnabled}
                      onChange={(event) => {
                        setSpotEnabled(event.target.checked);
                        if (!event.target.checked) handleStopLooping();
                      }}
                    />{" "}
                    Loop a passage (spot practice)
                  </label>
                  {spotEnabled ? (
                    <>
                      <label>
                        bars{" "}
                        <input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          aria-label="First bar to loop"
                          value={spotFromInput}
                          onChange={(event) => setSpotFromInput(event.target.value)}
                          style={{ width: 56 }}
                        />
                      </label>
                      <label>
                        to{" "}
                        <input
                          type="number"
                          min={1}
                          inputMode="numeric"
                          aria-label="Last bar to loop"
                          value={spotToInput}
                          onChange={(event) => setSpotToInput(event.target.value)}
                          style={{ width: 56 }}
                        />
                      </label>
                      <span>
                        {spotAwaitingEnd
                          ? "Tap the last bar to loop (or start now to loop just this bar)."
                          : "Tap a bar on the score to start choosing, or type the bars."}{" "}
                        Each pass is graded when you play past the last bar or stop; the next one starts when you play again.
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}

              {activeSpotRegion && (spotPasses.length > 0 || practiceMode !== "off" || spotNextPassPending) ? (
                <div style={styles.diagnosticHint}>
                  <strong>
                    Looping bars {activeSpotRegion.fromBar}–{activeSpotRegion.toBar}
                    {practiceMode !== "off" ? ` · pass ${spotPasses.length + 1}` : ""}
                    {spotNextPassPending ? " · next pass starting…" : ""}
                  </strong>
                  {spotPasses.length > 0 ? (
                    <ol style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                      {spotPasses.map((pass) => (
                        <li key={pass.pass}>
                          {pass.inTune}/{pass.notes} in tune · {pass.close} close · {pass.outOfTune} out
                          {pass.unclear > 0 ? ` · ${pass.unclear} unclear` : ""}
                          {pass.notPlayed > 0 ? ` · ${pass.notPlayed} not reached` : ""} · {pass.averageCentsError.toFixed(1)}¢ avg
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {spotNextPassPending ? (
                    <button type="button" style={styles.secondaryButton} onClick={handleStopLooping}>
                      Stop looping
                    </button>
                  ) : null}
                </div>
              ) : null}

              {trackingMode === "matchmaker" && (matchmakerStatus !== "idle" || matchmakerError) ? (
                <div style={styles.diagnosticHint}>
                  Alignment:{" "}
                  {matchmakerError
                    ? matchmakerError
                    : matchmakerStatus === "connecting"
                      ? "connecting to the alignment server…"
                      : matchmakerStatus === "preparing_score"
                        ? "preparing the score (first time for a piece takes a moment)…"
                        : matchmakerStatus === "waiting_for_sound"
                          ? activeSpotRegion
                            ? `ready — start playing from bar ${activeSpotRegion.fromBar}`
                            : "ready — start playing from the first note"
                          : matchmakerStatus === "streaming"
                            ? matchmakerLive && !matchmakerLive.gateOpen
                              ? "paused — holding position until you play again"
                              : "listening"
                            : matchmakerStatus === "completed"
                              ? "finished"
                              : matchmakerStatus}
                  {matchmakerLive ? (
                    <>
                      {" "}
                      · audio chunks sent {matchmakerLive.chunksSent} · matched the score {matchmakerLive.framesAccepted} · ignored as not-the-score{" "}
                      {matchmakerLive.framesRejected} · positions received {matchmakerLive.positionsReceived}
                      {matchmakerLive.lastQuarter !== null ? ` · server position ${matchmakerLive.lastQuarter.toFixed(2)} qn` : ""}
                      {matchmakerLive.stepIndex !== null ? ` · cursor on note #${matchmakerLive.stepIndex + 1}` : ""}
                      {matchmakerLive.latencyMs !== null ? ` · ${Math.round(matchmakerLive.latencyMs)}ms` : ""}
                    </>
                  ) : null}
                  {matchmakerError && practiceMode === "off" ? (
                    // Matchmaker is the default mode but depends on the separate Python server, so the
                    // most common failure is simply that it isn't running. Say how to fix that, and
                    // offer the mode that needs no server.
                    <div>
                      Score following needs the alignment server (in <code>server/</code>:{" "}
                      <code>uvicorn main:app --port 8000</code>).{" "}
                      <button
                        type="button"
                        style={styles.secondaryButton}
                        onClick={() => {
                          setMatchmakerError(null);
                          setTrackingMode("metronome");
                        }}
                      >
                        Use metronome mode instead
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {practiceMode === "off" && trackingMode === "metronome" ? (
                <label style={styles.diagnosticHint}>
                  Tempo{" "}
                  <input
                    type="number"
                    min={20}
                    max={300}
                    value={metronomeBpm}
                    // Deliberately does NOT clamp here -- clamping on every keystroke fought typing
                    // itself: entering "300" digit-by-digit passes through "3" first, which a
                    // same-keystroke clamp immediately snaps up to 20 (Math.max(20, 3)), overwriting
                    // the field before a second digit could ever be typed. Clamp only once, on blur,
                    // once the user is actually done editing; handleStartPracticing also clamps
                    // defensively before constructing the follower regardless of blur.
                    onChange={(event) => setMetronomeBpm(Number(event.target.value))}
                    onBlur={() => setMetronomeBpm((value) => Math.min(300, Math.max(20, value || 20)))}
                    style={{ width: "4em" }}
                  />{" "}
                  BPM -- the cursor advances on this clock alone; detected pitch is only compared
                  against whatever note is currently scheduled, never used to decide when to move.
                </label>
              ) : null}

              {practiceMode === "off" && trackingMode === "metronome" ? (
                <label style={styles.diagnosticHint}>
                  <input
                    type="checkbox"
                    checked={metronomeClickThroughoutEnabled}
                    onChange={(event) => setMetronomeClickThroughoutEnabled(event.target.checked)}
                  />{" "}
                  Click throughout practice, not just the one-bar count-in before it starts
                </label>
              ) : null}

              {practiceMode === "off" && trackingMode === "metronome" ? (
                <label style={styles.diagnosticHint}>
                  <input
                    type="checkbox"
                    checked={bowAttackDetectionEnabled}
                    onChange={(event) => setBowAttackDetectionEnabled(event.target.checked)}
                  />{" "}
                  Bow attack detection (let a real bow attack shift the note boundary early/late,
                  off by default -- the cursor otherwise advances strictly on the beat, with no
                  dependency on detected pitch/onsets at all)
                </label>
              ) : null}

              {practiceMode === "off" && trackingMode === "metronome" ? (
                <label style={styles.diagnosticHint}>
                  Click subdivision{" "}
                  <select
                    value={clickSubdivision}
                    onChange={(event) => setClickSubdivision(event.target.value as ClickSubdivision)}
                  >
                    <option value="auto">Auto (quarter, or dotted-quarter for 6/8, 9/8, 12/8, ...)</option>
                    <option value="quarter">Quarter note</option>
                    <option value="dottedQuarter">Dotted quarter (compound meter)</option>
                    <option value="eighth">Eighth note</option>
                  </select>
                </label>
              ) : null}

              {practiceMode === "off" && trackingMode === "listening" ? (
                <label style={styles.diagnosticHint}>
                  <input
                    type="checkbox"
                    checked={fuzzySequenceMatchingEnabled}
                    onChange={(event) => setFuzzySequenceMatchingEnabled(event.target.checked)}
                  />{" "}
                  Dev: fuzzy sequence matching (gap-tolerant resync, off by default -- see
                  ScoreFollowerConfig.fuzzySequenceMatchingEnabled)
                </label>
              ) : null}

              {practiceMode === "off" && trackingMode === "listening" && fuzzySequenceMatchingEnabled ? (
                <label style={styles.diagnosticHint}>
                  Dev: max consecutive missed notes a resync can bridge{" "}
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={fuzzySequenceMaxSkips}
                    onChange={(event) => setFuzzySequenceMaxSkips(Math.max(1, Number(event.target.value) || 1))}
                    style={{ width: "3em" }}
                  />{" "}
                  (default 1 -- see ScoreFollowerConfig.fuzzySequenceMaxSkips)
                </label>
              ) : null}

              {practiceMode === "off" && trackingMode === "listening" ? (
                <label style={styles.diagnosticHint}>
                  <input
                    type="checkbox"
                    checked={adaptiveStabilityWindowEnabled}
                    onChange={(event) => setAdaptiveStabilityWindowEnabled(event.target.checked)}
                  />{" "}
                  Dev: adaptive stability window (tempo-scaled implicit-onset timing, off by
                  default -- see ScoreFollowerConfig.adaptiveStabilityWindowEnabled)
                </label>
              ) : null}

              {practiceMode === "off" && trackingMode === "listening" ? (
                <label style={styles.diagnosticHint}>
                  <input
                    type="checkbox"
                    checked={energyOnsetFusionEnabled}
                    onChange={(event) => setEnergyOnsetFusionEnabled(event.target.checked)}
                  />{" "}
                  Dev: energy onset fusion (adds a second onset detector + extra settle time on
                  single-detector onsets, off by default -- see
                  ScoreFollowerConfig.energyOnsetFusionEnabled). Takes effect on the NEXT
                  microphone start, not while it's already running -- stop and restart the mic
                  above after changing this.
                </label>
              ) : null}

              {renderError ? <div style={styles.errorBox}>Could not render this score: {renderError}</div> : null}

              <div style={{ position: "relative", marginTop: 16 }}>
                <div ref={scoreContainerRef} style={styles.scoreContainer} />
                {measureBoxes.length > 0 ? (
                  <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }} aria-label="Bars to loop">
                    {measureBoxes.map((box) => {
                      const bar = box.measureIndex + 1;
                      const from = Number.parseInt(spotFromInput, 10);
                      const to = Number.parseInt(spotToInput, 10);
                      const selected = Number.isFinite(from) && Number.isFinite(to) && bar >= Math.min(from, to) && bar <= Math.max(from, to);
                      return (
                        <button
                          key={box.measureIndex}
                          type="button"
                          aria-label={`Bar ${bar}`}
                          aria-pressed={selected}
                          disabled={!spotSelecting}
                          onClick={() => handleSpotBarTap(box.measureIndex)}
                          style={{
                            position: "absolute",
                            left: box.left,
                            top: box.top,
                            width: box.width,
                            height: box.height,
                            padding: 0,
                            border: selected ? "2px solid rgba(255, 176, 32, 0.9)" : spotSelecting ? "1px dashed rgba(90, 90, 90, 0.25)" : "none",
                            borderRadius: 6,
                            background: selected ? "rgba(255, 176, 32, 0.18)" : "transparent",
                            cursor: spotSelecting ? "pointer" : "default",
                            pointerEvents: spotSelecting ? "auto" : "none"
                          }}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </div>

              {practiceMode === "active" && followerState?.current ? (
                <div style={styles.readoutGrid}>
                  <div style={styles.readoutCard}>
                    <div style={styles.readoutLabel}>Current note</div>
                    <div style={styles.readoutValueLarge}>{followerState.current.pitchLabel ?? "--"}</div>
                    <div style={styles.diagnosticHint}>Measure {followerState.current.measureIndex + 1}</div>
                  </div>
                  <div style={styles.readoutCard}>
                    <div style={styles.readoutLabel}>Intonation</div>
                    <div style={{ ...styles.readoutValueLarge, color: intonationColor }}>{intonationLabel}</div>
                    <div style={styles.diagnosticHint}>{formatCents(liveCentsFromExpected)} vs. expected</div>
                  </div>
                </div>
              ) : null}

              {followerState?.status === "scoring" ? (
                <div style={styles.importResult}>
                  <p style={styles.diagnosticHint}>
                    {offlineScoringProgress === null
                      ? "Aligning your recording with the score…"
                      : `Scoring your recording… ${Math.round(offlineScoringProgress * 100)}%`}
                  </p>
                </div>
              ) : null}

              {followerState?.status === "completed" || followerState?.status === "stopped" ? (
                <div style={styles.importResult}>
                  <p style={styles.diagnosticHint}>
                    {followerState.status === "completed" ? "Practice session complete" : "Practice session ended"} —{" "}
                    {sessionSummary.inTuneNoteIds.length} in tune, {sessionSummary.closeNoteIds.length} close,{" "}
                    {sessionSummary.unstableNoteIds.length} note
                    {sessionSummary.unstableNoteIds.length === 1 ? "" : "s"} out of tune,{" "}
                    {sessionSummary.notPlayedNoteIds.length} note
                    {sessionSummary.notPlayedNoteIds.length === 1 ? "" : "s"} not played,{" "}
                    {sessionSummary.unmeasuredNoteIds.length > 0
                      ? `${sessionSummary.unmeasuredNoteIds.length} too fast or unclear to measure, `
                      : ""}
                    {sessionSummary.averageCentsError.toFixed(1)} cents average error.
                  </p>
                  <div style={styles.diagnosticHint} role="radiogroup" aria-label="Grade against">
                    Grade against:{" "}
                    <label>
                      <input
                        type="radio"
                        name="grade-reference"
                        checked={gradeReference === "own"}
                        onChange={() => setGradeReference("own")}
                      />{" "}
                      my own tuning
                    </label>{" "}
                    <label>
                      <input
                        type="radio"
                        name="grade-reference"
                        checked={gradeReference === "a440"}
                        onChange={() => setGradeReference("a440")}
                      />{" "}
                      A440
                    </label>
                    {gradeReference === "own" && sessionSummary.referenceSource !== "a440"
                      ? ` — your ${sessionSummary.referenceSource === "open_strings" ? "open strings" : "playing overall"} sat ${
                          sessionSummary.referenceCents >= 0 ? "+" : ""
                        }${sessionSummary.referenceCents.toFixed(0)}¢ from A440`
                      : ""}
                    .
                  </div>
                  {sessionSummary.stringDriftCents !== null && Math.abs(sessionSummary.stringDriftCents) > 8 ? (
                    <p style={{ ...styles.diagnosticHint, color: "#ffb020" }}>
                      Your open strings were about {Math.abs(sessionSummary.stringDriftCents).toFixed(0)}¢{" "}
                      {sessionSummary.stringDriftCents < 0 ? "flat" : "sharp"} of your fingered notes. They may have
                      drifted: retune before the next take
                      {gradeReference === "own" ? ', or grade against A440 so fingered notes aren\'t marked off because of it' : ""}.
                    </p>
                  ) : null}
                  <div style={styles.diagnosticHint} role="radiogroup" aria-label="Strictness">
                    Strictness:{" "}
                    {(Object.keys(STRICTNESS_BANDS) as GradeStrictness[]).map((key) => (
                      <label key={key} style={{ marginRight: 10 }}>
                        <input
                          type="radio"
                          name="grade-strictness"
                          checked={gradeStrictness === key}
                          onChange={() => chooseStrictness(key)}
                        />{" "}
                        {STRICTNESS_BANDS[key].label} (±{STRICTNESS_BANDS[key].inTuneCents}¢)
                      </label>
                    ))}
                    <br />
                    <span style={{ color: "#8ee8cb" }}>Green</span> within ±{STRICTNESS_BANDS[gradeStrictness].inTuneCents}¢,{" "}
                    <span style={{ color: "#ffb020" }}>amber</span> up to ±{STRICTNESS_BANDS[gradeStrictness].closeCents}¢,{" "}
                    <span style={{ color: "#ff4d4d" }}>red</span> beyond, <span style={{ color: "#a07ee0" }}>purple</span> too fast or
                    unclear to measure, <span style={{ color: "#9aa0a6" }}>grey</span> not played.
                  </div>
                  {finalScoringSource === "live" ? (
                    <p style={styles.diagnosticHint}>
                      Approximate: the full-recording analysis didn't finish, so this uses the live estimate.
                    </p>
                  ) : null}
                  <div style={styles.buttonRow}>
                    {takeAvailable && lastTakeRef.current ? (
                      <button
                        type="button"
                        style={styles.secondaryButton}
                        onClick={() => {
                          const saved = lastTakeRef.current;
                          if (!saved || !followerState) return;
                          const follower = followerRef.current;
                          downloadTake(
                            {
                              ...saved.take,
                              savedAt: new Date().toISOString(),
                              history: followerState.history,
                              scoringSource: follower instanceof MatchmakerScoreFollower ? follower.getScoringSource() : null
                            },
                            saved.audio
                          );
                        }}
                      >
                        Download this take
                      </button>
                    ) : null}
                    <button type="button" style={styles.primaryButton} onClick={() => handleStartPracticing()}>
                      Practice again
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: "24px"
  },
  shell: {
    width: "100%",
    maxWidth: "920px"
  },
  heroCard: {
    position: "relative",
    overflow: "hidden",
    borderRadius: "28px",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    background: "linear-gradient(180deg, rgba(12, 22, 37, 0.92), rgba(8, 14, 23, 0.96))",
    boxShadow: "0 30px 80px rgba(0, 0, 0, 0.38)",
    padding: "28px"
  },
  topRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "start",
    marginBottom: "28px"
  },
  kicker: {
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.2em",
    fontSize: "12px",
    color: "rgba(204, 214, 232, 0.72)"
  },
  title: {
    margin: "8px 0 0",
    fontSize: "clamp(2.4rem, 4vw, 4.25rem)",
    lineHeight: 1,
    letterSpacing: "-0.04em"
  },
  statusPill: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "999px",
    padding: "10px 14px",
    fontSize: "13px",
    fontWeight: 600,
    border: "1px solid rgba(255, 255, 255, 0.12)"
  },
  readoutGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "16px"
  },
  diagnosticsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "16px",
    marginTop: "16px"
  },
  readoutCard: {
    borderRadius: "20px",
    padding: "18px",
    background: "rgba(255, 255, 255, 0.03)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    minHeight: "122px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between"
  },
  diagnosticCard: {
    borderRadius: "20px",
    padding: "18px",
    background: "rgba(255, 255, 255, 0.03)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    minHeight: "138px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: "10px"
  },
  readoutLabel: {
    color: "rgba(204, 214, 232, 0.7)",
    fontSize: "13px",
    letterSpacing: "0.04em",
    textTransform: "uppercase"
  },
  readoutValueLarge: {
    fontSize: "clamp(2.2rem, 6vw, 4.6rem)",
    fontWeight: 700,
    letterSpacing: "-0.05em"
  },
  readoutValue: {
    fontSize: "clamp(1.15rem, 2.3vw, 1.6rem)",
    fontWeight: 600,
    letterSpacing: "-0.03em"
  },
  meterTrack: {
    width: "100%",
    height: "10px",
    borderRadius: "999px",
    background: "rgba(255, 255, 255, 0.06)",
    overflow: "hidden"
  },
  meterFill: {
    height: "100%",
    borderRadius: "inherit",
    background: "linear-gradient(90deg, #4cb2ff 0%, #8ee8cb 100%)",
    boxShadow: "0 0 18px rgba(76, 178, 255, 0.45)"
  },
  diagnosticHint: {
    color: "rgba(204, 214, 232, 0.68)",
    fontSize: "13px",
    lineHeight: 1.4
  },
  metaRow: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "12px",
    marginTop: "18px",
    padding: "18px 0 4px"
  },
  metaLabel: {
    color: "rgba(204, 214, 232, 0.66)",
    fontSize: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.08em"
  },
  metaValue: {
    marginTop: "6px",
    fontSize: "15px",
    fontWeight: 600
  },
  deviceLabel: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginTop: "18px",
    color: "rgba(204, 214, 232, 0.7)",
    fontSize: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    maxWidth: "360px"
  },
  deviceSelect: {
    font: "inherit",
    textTransform: "none",
    letterSpacing: "normal",
    fontSize: "14px",
    padding: "10px 12px",
    borderRadius: "12px",
    background: "rgba(255, 255, 255, 0.04)",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    color: "#f5f7fb"
  },
  buttonRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "12px",
    marginTop: "24px"
  },
  primaryButton: {
    border: "none",
    borderRadius: "999px",
    padding: "14px 20px",
    background: "linear-gradient(135deg, #8ee8cb 0%, #4cb2ff 100%)",
    color: "#06111d",
    fontWeight: 700,
    cursor: "pointer"
  },
  secondaryButton: {
    border: "1px solid rgba(255, 255, 255, 0.14)",
    borderRadius: "999px",
    padding: "14px 20px",
    background: "rgba(255, 255, 255, 0.04)",
    color: "#f5f7fb",
    fontWeight: 600,
    cursor: "pointer"
  },
  errorBox: {
    marginTop: "18px",
    padding: "14px 16px",
    borderRadius: "16px",
    background: "rgba(255, 77, 77, 0.12)",
    border: "1px solid rgba(255, 77, 77, 0.24)",
    color: "#ffd0d0"
  },
  caption: {
    margin: "20px 0 0",
    color: "rgba(204, 214, 232, 0.68)",
    lineHeight: 1.55,
    maxWidth: "68ch"
  },
  importCard: {
    position: "relative",
    overflow: "hidden",
    borderRadius: "28px",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    background: "linear-gradient(180deg, rgba(12, 22, 37, 0.92), rgba(8, 14, 23, 0.96))",
    boxShadow: "0 30px 80px rgba(0, 0, 0, 0.38)",
    padding: "28px",
    marginTop: "24px"
  },
  subtitle: {
    margin: "8px 0 0",
    fontSize: "clamp(1.4rem, 2.4vw, 2rem)",
    letterSpacing: "-0.03em"
  },
  hiddenFileInput: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0
  },
  importResult: {
    marginTop: "18px"
  },
  correctionPanel: {
    marginTop: "18px",
    padding: "16px",
    borderRadius: "16px",
    background: "rgba(255, 255, 255, 0.03)",
    border: "1px solid rgba(255, 255, 255, 0.08)"
  },
  correctionRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    alignItems: "center",
    marginTop: "8px"
  },
  scoreContainer: {
    background: "#f7f4ee",
    borderRadius: "16px",
    padding: "16px",
    overflowX: "auto"
  }
};

const statusStyles: Record<LiveCaptureState["status"], CSSProperties> = {
  idle: {
    background: "rgba(255, 255, 255, 0.04)",
    color: "rgba(245, 247, 251, 0.8)"
  },
  requesting: {
    background: "rgba(111, 191, 255, 0.14)",
    color: "#bfe7ff"
  },
  calibrating: {
    background: "rgba(255, 193, 109, 0.16)",
    color: "#ffe0aa"
  },
  listening: {
    background: "rgba(107, 232, 180, 0.16)",
    color: "#bff4df"
  },
  suspended: {
    background: "rgba(255, 208, 109, 0.16)",
    color: "#ffe3a2"
  },
  error: {
    background: "rgba(255, 84, 84, 0.16)",
    color: "#ffb3b3"
  }
};