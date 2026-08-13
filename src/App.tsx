import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import {
  createMicrophoneCaptureController,
  type LiveCaptureState,
  type MicrophoneCaptureController,
  type StartCaptureOptions
} from "../audio/captureModule";
import { importPhotoToScore, type OmrImportResult } from "../score/omrImport";
import { renderScore, type RenderedScoreHandle } from "../score/renderer";

type ImportState = "idle" | "loading" | "success" | "error";

const LIVE_CAPTURE_OPTIONS: StartCaptureOptions = {
  frameSize: 2048,
  hopSize: 512,
  confidenceThreshold: 0.4,
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

  const [importState, setImportState] = useState<ImportState>("idle");
  const [importResult, setImportResult] = useState<OmrImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const scoreContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = controllerRef.current!;
    const unsubscribe = controller.subscribe(setCaptureState);

    return () => {
      unsubscribe();
      void controller.stop();
    };
  }, []);

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
      stripUnreliableBeaming: importResult.score.sourceType === "photo"
    })
      .then((resolvedHandle) => {
        if (cancelled) {
          resolvedHandle.unmount();
          return;
        }
        handle = resolvedHandle;
      })
      .catch((err) => {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : "Unknown error while rendering the score.");
        }
      });

    return () => {
      cancelled = true;
      handle?.unmount();
    };
  }, [importState, importResult]);

  async function handleStart(): Promise<void> {
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }

    setIsStarting(true);
    try {
      await controller.start(LIVE_CAPTURE_OPTIONS);
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

  const noteDisplay = captureState.isSilent || captureState.frequencyHz === null ? "No note" : captureState.note ?? "--";
  const pitchClass = captureState.isSilent ? "idle" : captureState.note ? "active" : "searching";
  const levelRatio = captureState.silenceRmsThreshold > 0 ? Math.min(1, captureState.rms / captureState.silenceRmsThreshold) : 0;

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

          <label style={styles.secondaryButton}>
            Choose sheet music photo
            <input type="file" accept="image/*" onChange={handleSheetFileSelected} style={styles.hiddenFileInput} />
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

              <div style={styles.buttonRow}>
                <button type="button" style={styles.secondaryButton} onClick={handleDownloadMusicXml}>
                  Download MusicXML
                </button>
              </div>

              {renderError ? <div style={styles.errorBox}>Could not render this score: {renderError}</div> : null}

              <div ref={scoreContainerRef} style={styles.scoreContainer} />
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