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
import { renderScore, type RenderedScoreHandle, type ScoreCursor, type NoteHighlight } from "../score/renderer";
import { ScoreFollower, DEFAULT_SCORE_FOLLOWER_CONFIG, type ScoreFollowerState } from "../practice/cursor";
import { MetronomeScoreFollower, DEFAULT_METRONOME_FOLLOWER_CONFIG } from "../practice/metronomeFollower";
import { summarizePracticeSession } from "../practice/reviewSummary";

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

const OUT_OF_TUNE_HIGHLIGHT_COLOR = "#ff4d4d";
const NOT_PLAYED_HIGHLIGHT_COLOR = "#ffc94d";

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

  const followerRef = useRef<ScoreFollower | MetronomeScoreFollower | null>(null);
  const [scoreCursor, setScoreCursor] = useState<ScoreCursor | null>(null);
  const [followerState, setFollowerState] = useState<ScoreFollowerState | null>(null);
  const [practiceMode, setPracticeMode] = useState<"off" | "active">("off");
  // Which mechanism drives cursor advancement during practice -- "listening" is the existing
  // pitch/onset-driven ScoreFollower; "metronome" is MetronomeScoreFollower
  // (practice/metronomeFollower.ts), a separate, simpler mode that advances purely on a
  // user-chosen tempo and never looks at detected pitch/onsets to decide when to move. Added as
  // an alternative, not a replacement, since pitch-based following isn't reliable live yet --
  // see metronomeFollower.ts's header comment.
  const [trackingMode, setTrackingMode] = useState<"listening" | "metronome">("listening");
  const [metronomeBpm, setMetronomeBpm] = useState(90);
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
      composerOverride: importResult.score.composer || undefined
    })
      .then((resolvedHandle) => {
        if (cancelled) {
          resolvedHandle.unmount();
          return;
        }
        handle = resolvedHandle;
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
      setScoreCursor(null);
      setFollowerState(null);
      setPracticeMode("off");
    };
  }, [importState, importResult]);

  useEffect(() => {
    if (importResult?.score.tempoBpm) {
      setMetronomeBpm(importResult.score.tempoBpm);
    }
  }, [importResult]);

  useEffect(() => {
    if (practiceMode === "active" && captureState.status !== "listening") {
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
    const summary = summarizePracticeSession(followerState.history);
    const highlights: NoteHighlight[] = [
      ...summary.unstableNoteIds.map((id) => ({ stepIndex: Number(id), color: OUT_OF_TUNE_HIGHLIGHT_COLOR })),
      ...summary.notPlayedNoteIds.map((id) => ({ stepIndex: Number(id), color: NOT_PLAYED_HIGHLIGHT_COLOR }))
    ];
    scoreCursor.highlightNotes(highlights);
    // Back to "off" now that the session has actually ended (naturally or via End Practice) --
    // this is also what hides the live "Current note"/"Intonation" readout below (gated on
    // practiceMode === "active") and swaps the button back to "Practice this score", so both
    // need this, not just the button.
    setPracticeMode("off");
  }, [followerState, scoreCursor]);

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

  function handleStartPracticing(): void {
    if (!scoreCursor || captureState.status !== "listening") {
      return;
    }

    highlightedSessionRef.current = false;
    // Clear any red/yellow highlights left over from a previous session -- otherwise they'd sit
    // on the score, misrepresenting THIS session, since highlightNotes() only runs again at the
    // end of this new one.
    scoreCursor.highlightNotes([]);
    // TEMPORARY diagnostic -- see whether the BPM the field shows actually matches what's about to
    // be handed to the follower. Remove alongside the matching log in metronomeFollower.ts once the
    // "still slow even at 300" report is resolved.
    if (trackingMode === "metronome") {
      console.debug(`[metronome] raw metronomeBpm state at practice-start: ${metronomeBpm}`);
    }
    const follower: ScoreFollower | MetronomeScoreFollower =
      trackingMode === "metronome"
        ? new MetronomeScoreFollower(scoreCursor, {
            ...DEFAULT_METRONOME_FOLLOWER_CONFIG,
            bpm: Math.min(300, Math.max(20, metronomeBpm || 90))
          })
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

    // TEMPORARY debug hook for live diagnosis -- run `__scoreFollower.getTrace()` (listening mode
    // only; the metronome follower has no resync trace to inspect) in the browser console after a
    // practice session. Remove once the resync algorithm is validated against real playing.
    (window as unknown as { __scoreFollower?: ScoreFollower | MetronomeScoreFollower }).__scoreFollower = follower;
  }

  function handleStopPracticing(): void {
    followerRef.current?.stop();
    scoreCursor?.hide();
    setPracticeMode("off");
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
      const result = await importPhotoToScore(bytes);
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
      const score = await importMusicXmlToScore(xmlData);
      setImportResult({ score, transientBoundingBoxes: [], xmlData });
      setImportState("success");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Unknown error while importing the MusicXML file.");
      setImportState("error");
    }
  }

  const noteDisplay = captureState.isSilent || captureState.frequencyHz === null ? "No note" : captureState.note ?? "--";
  const pitchClass = captureState.isSilent ? "idle" : captureState.note ? "active" : "searching";
  const levelRatio = captureState.silenceRmsThreshold > 0 ? Math.min(1, captureState.rms / captureState.silenceRmsThreshold) : 0;

  const liveCentsFromExpected = followerState?.liveCentsOffFromExpected ?? null;
  const isInTune = liveCentsFromExpected !== null && Math.abs(liveCentsFromExpected) <= DEFAULT_SCORE_FOLLOWER_CONFIG.inTuneCentsThreshold;
  const intonationLabel = liveCentsFromExpected === null ? "Listening…" : isInTune ? "In tune" : "Off pitch";
  const intonationColor = liveCentsFromExpected === null ? "#f5f7fb" : isInTune ? "#8ee8cb" : "#ff8a8a";
  const sessionSummary = summarizePracticeSession(followerState?.history ?? []);

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

              <div style={styles.buttonRow}>
                <button type="button" style={styles.secondaryButton} onClick={handleDownloadMusicXml}>
                  Download MusicXML
                </button>
                {practiceMode === "active" ? (
                  <button type="button" style={styles.secondaryButton} onClick={handleEndPracticing}>
                    End Practice
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
                      checked={trackingMode === "metronome"}
                      onChange={() => setTrackingMode("metronome")}
                    />{" "}
                    Metronome (tempo-driven, no pitch tracking)
                  </label>
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

              <div ref={scoreContainerRef} style={styles.scoreContainer} />

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

              {followerState?.status === "completed" || followerState?.status === "stopped" ? (
                <div style={styles.importResult}>
                  <p style={styles.diagnosticHint}>
                    {followerState.status === "completed" ? "Practice session complete" : "Practice session ended"} —{" "}
                    {sessionSummary.unstableNoteIds.length} note
                    {sessionSummary.unstableNoteIds.length === 1 ? "" : "s"} out of tune,{" "}
                    {sessionSummary.notPlayedNoteIds.length} note
                    {sessionSummary.notPlayedNoteIds.length === 1 ? "" : "s"} not played,{" "}
                    {sessionSummary.averageCentsError.toFixed(1)} cents average error.
                  </p>
                  <div style={styles.buttonRow}>
                    <button type="button" style={styles.primaryButton} onClick={handleStartPracticing}>
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
  scoreContainer: {
    marginTop: "16px",
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