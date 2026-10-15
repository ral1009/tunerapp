// The score engine: the web app's own score code (MusicXML import, OSMD rendering, the cursor,
// note colours) wrapped in a message interface, so the native app can show and drive sheet music
// in a WebView. Bundled into one HTML string by mobile/scripts/build-score-engine.mjs.
//
// Messages in: window.__scoreEngine.receive(command) (react-native-webview's injectJavaScript) or a
// window "message" event (iframe in the web build). Messages out: ReactNativeWebView.postMessage
// when present, else parent.postMessage. See protocol.ts.

import { applyNoteCorrectionsToXml } from "../correctionUI/noteXmlCorrection";
import { importMusicXmlToScore } from "../musicxmlImport";
import { renderScore, type RenderedScoreHandle } from "../renderer";
import { scoreRecordingOffline } from "../../practice/offlineIntonationScorer";
import { buildReference, DeviceAligner, type AlignmentReference } from "../../practice/onDevice/deviceAligner";
import { scoreNotes } from "../scoreNotes";
import type { EngineCommand, EngineEvent, ScoreLayout, ScoreTheme } from "./protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
    __scoreEngine?: { receive: (command: EngineCommand) => void };
  }
}

// The page matches the app's ivory sheet / ebony ground; the cursor is gold rather than OSMD's green.
const THEMES: Record<ScoreTheme, { page: string; ink: string; select: string; selectRule: string; cursor: string }> = {
  paper: { page: "#FAF6EC", ink: "#14110E", select: "rgba(186,140,62,0.14)", selectRule: "rgba(154,111,44,0.9)", cursor: "#C9963F" },
  ebony: { page: "#0B0806", ink: "#EFE5D1", select: "rgba(201,164,106,0.10)", selectRule: "rgba(201,164,106,0.9)", cursor: "#E3C58F" }
};

function send(event: EngineEvent): void {
  const text = JSON.stringify(event);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
  else window.parent?.postMessage(text, "*");
}

const host = document.getElementById("score") as HTMLDivElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
let handle: RenderedScoreHandle | null = null;
// Built once per render: buildQuarterIndex walks the whole score and resets the cursor, far too
// heavy for every position update during practice (up to 30 a second).
let quarterIndexCache: ReturnType<RenderedScoreHandle["cursor"]["buildQuarterIndex"]> = [];
let currentXml = "";
let currentTheme: ScoreTheme = "paper";
let currentLayout: ScoreLayout = "scroll";
// Behind the pages in page layout: the app's ebony, so the sheets sit on it like paper on a desk.
const PAGE_GROUND = "#0B0806";
// A4 portrait, height over width.
const PAGE_ASPECT = 297 / 210;
let selection: { from: number; to: number } | null = null;
let titleForRender = "";
let composerForRender = "";

function applyTheme(theme: ScoreTheme): void {
  currentTheme = theme;
  const pages = currentLayout === "pages";
  document.body.classList.toggle("pages", pages);
  document.body.style.background = pages ? PAGE_GROUND : THEMES[theme].page;
  document.documentElement.style.setProperty("--page", THEMES[theme].page);
  sizePages();
}

// Page layout: OSMD scales each page to the container's width. Upright, the container is made
// exactly as wide as a page that fits the screen whole, top to bottom; turned sideways, a whole
// page would be too small to read, so pages fill the width (to a limit) and scroll.
const MAX_PAGE_WIDTH = 900;
function sizePages(): void {
  if (currentLayout !== "pages") {
    host.style.width = "";
    return;
  }
  const available = window.innerWidth - 32;
  const upright = window.innerHeight >= window.innerWidth;
  const width = upright ? Math.min(available, (window.innerHeight - 32) / PAGE_ASPECT) : Math.min(available, MAX_PAGE_WIDTH);
  host.style.width = `${Math.floor(Math.max(300, width))}px`;
}

async function render(): Promise<void> {
  handle?.unmount();
  handle = await renderScore(currentXml, host, {
    drawTitle: false,
    drawComposer: false,
    drawPartNames: false,
    titleOverride: titleForRender,
    composerOverride: composerForRender || undefined,
    musicColor: THEMES[currentTheme].ink,
    pageFormat: currentLayout === "pages" ? "A4_P" : undefined,
    cursorColor: THEMES[currentTheme].cursor
  });
  quarterIndexCache = handle.cursor.buildQuarterIndex();
  drawSelection();
}

// Bars as tappable regions; the selected range drawn as a soft gold wash with a gold rule.
function drawSelection(): void {
  overlay.innerHTML = "";
  if (!handle || !selection) return;
  const { from, to } = selection;
  const theme = THEMES[currentTheme];
  for (const box of handle.getMeasureBoxes()) {
    if (box.measureIndex < from || box.measureIndex > to) continue;
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;background:${theme.select};border-top:1px solid ${theme.selectRule};border-bottom:1px solid ${theme.selectRule};pointer-events:none;`;
    overlay.appendChild(el);
  }
}

host.addEventListener("click", (event) => {
  if (!handle) return;
  const rect = host.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = handle.getMeasureBoxes().find((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height);
  if (hit) send({ type: "barTap", measureIndex: hit.measureIndex });
});

// ---- score following on the device (practice/onDevice) ----------------------------------------
// The reference is a pure function of (score, sample rate): built once per score and kept.
const references = new Map<string, AlignmentReference>();
let aligner: { id: string; aligner: DeviceAligner; chunks: number; busyMs: number; worstMs: number } | null = null;
// The last take aligned here, for "grade" without an audioUrl.
let lastTake: Float32Array | null = null;

function decodeF32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
}

function alignmentReference(sampleRate: number): AlignmentReference {
  const key = `${sampleRate}:${currentXml}`;
  let reference = references.get(key);
  if (!reference) {
    const doc = new DOMParser().parseFromString(currentXml, "application/xml");
    reference = buildReference(scoreNotes(doc), sampleRate);
    references.clear(); // one score at a time is all a screen uses
    references.set(key, reference);
  }
  return reference;
}

function finishAlignment(id: string, completed: boolean): void {
  if (!aligner || aligner.id !== id) return;
  const session = aligner;
  aligner = null;
  lastTake = session.aligner.takeAudio();
  send({ type: "alignPath", id, path: session.aligner.finish(), completed });
}

function handleAlignment(command: Extract<EngineCommand, { type: "alignStart" | "alignAudio" | "alignSeek" | "alignFinish" | "alignStop" }>): void {
  try {
    switch (command.type) {
      case "alignStart": {
        const reference = alignmentReference(command.sampleRate);
        aligner = { id: command.id, aligner: new DeviceAligner(reference), chunks: 0, busyMs: 0, worstMs: 0 };
        send({ type: "alignReady", id: command.id, hopLength: reference.hop, totalQuarters: reference.totalQuarters });
        return;
      }
      case "alignAudio": {
        if (!aligner || aligner.id !== command.id) return;
        const started = performance.now();
        const quarter = aligner.aligner.push(decodeF32(command.f32));
        if (quarter !== null) send({ type: "alignPosition", id: command.id, quarter });
        const took = performance.now() - started;
        aligner.busyMs += took;
        aligner.worstMs = Math.max(aligner.worstMs, took);
        aligner.chunks += 1;
        if (aligner.chunks % 8 === 0) {
          send({ type: "alignStats", id: command.id, ...aligner.aligner.stats(), processed: aligner.aligner.frames + 1, busyMs: aligner.busyMs, worstMs: aligner.worstMs });
          aligner.busyMs = 0;
          aligner.worstMs = 0;
        }
        // The follower stops at the last note; the server then ends the session with its path.
        if (aligner.aligner.completed) finishAlignment(command.id, true);
        return;
      }
      case "alignSeek":
        if (aligner?.id === command.id) aligner.aligner.seek(command.quarter);
        return;
      case "alignFinish":
        finishAlignment(command.id, false);
        return;
      case "alignStop":
        if (aligner?.id === command.id) aligner = null;
        return;
    }
  } catch (error) {
    send({ type: "alignFailed", id: command.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function grade(command: Extract<EngineCommand, { type: "grade" }>): Promise<void> {
  try {
    let audio: Float32Array;
    if (command.audioUrl) {
      const response = await fetch(command.audioUrl);
      if (!response.ok) throw new Error(`couldn't fetch the take from the server (${response.status})`);
      audio = new Float32Array(await response.arrayBuffer());
    } else {
      if (!lastTake) throw new Error("no take to grade");
      audio = lastTake;
    }
    let lastSent = -1;
    const records = await scoreRecordingOffline(audio, command.path, command.notes, command.quarterIndex, command.setup, command.config, (fraction) => {
      if (fraction - lastSent >= 0.05 || fraction === 1) {
        lastSent = fraction;
        send({ type: "gradeProgress", id: command.id, fraction });
      }
    });
    send({ type: "graded", id: command.id, records });
  } catch (error) {
    send({ type: "gradeFailed", id: command.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function receive(command: EngineCommand): Promise<void> {
  try {
    switch (command.type) {
      case "grade":
        await grade(command);
        return;
      case "alignStart":
      case "alignAudio":
      case "alignSeek":
      case "alignFinish":
      case "alignStop":
        handleAlignment(command);
        return;
      case "load": {
        currentXml = command.xml;
        currentLayout = command.layout ?? "scroll";
        applyTheme(command.theme);
        const meta = await readMeta(command.xml);
        if (!command.render) {
          send({ type: "loaded", meta, notes: [], quarterIndex: [], rendered: false });
          return;
        }
        await render();
        const cursor = (handle as RenderedScoreHandle).cursor;
        const notes = cursor.listNotes();
        const quarterIndex = quarterIndexCache;
        send({ type: "loaded", meta, notes, quarterIndex, rendered: true });
        return;
      }
      case "theme":
        applyTheme(command.theme);
        if (currentXml) await render();
        return;
      case "cursor":
        if (!handle) return;
        if (command.action === "show") {
          handle.cursor.setHighlightColor(THEMES[currentTheme].cursor);
          handle.cursor.show();
        }
        else if (command.action === "hide") handle.cursor.hide();
        else handle.cursor.reset();
        return;
      case "seek": {
        if (!handle) return;
        const landed = handle.cursor.seekToQuarter(quarterIndexCache, command.quarter);
        keepCursorInView();
        send({ type: "cursorMoved", stepIndex: landed?.stepIndex ?? null });
        return;
      }
      case "highlight":
        handle?.cursor.highlightNotes(command.highlights);
        drawSelection();
        return;
      case "selectBars":
        selection = command.from === null || command.to === null ? null : { from: Math.min(command.from, command.to), to: Math.max(command.from, command.to) };
        drawSelection();
        return;
      case "correct": {
        currentXml = applyNoteCorrectionsToXml(currentXml, command.corrections);
        const meta = await readMeta(currentXml);
        await render();
        const cursor = (handle as RenderedScoreHandle).cursor;
        send({ type: "xmlChanged", xml: currentXml, meta, notes: cursor.listNotes(), quarterIndex: quarterIndexCache });
        return;
      }
      case "scrollToBar": {
        const box = handle?.getMeasureBoxes().find((b) => b.measureIndex === command.measureIndex);
        if (box) window.scrollTo({ top: Math.max(0, box.top - 80), behavior: "smooth" });
        return;
      }
    }
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

// Like turning the page: when the cursor's line drifts out of the middle of the screen, bring it
// back to about a third of the way down so the next line is visible too.
function keepCursorInView(): void {
  const cursorEl = document.querySelector<HTMLElement>("[id^='cursorImg']");
  if (!cursorEl || cursorEl.style.display === "none") return;
  const rect = cursorEl.getBoundingClientRect();
  const viewport = window.innerHeight;
  if (rect.top < viewport * 0.12 || rect.bottom > viewport * 0.85) {
    window.scrollBy({ top: rect.top - viewport * 0.3, behavior: "smooth" });
  }
}

async function readMeta(xml: string) {
  const score = await importMusicXmlToScore(xml);
  titleForRender = score.title;
  composerForRender = score.composer;
  return {
    title: score.title,
    composer: score.composer,
    measureCount: score.measures.length,
    keySignature: score.keySignature,
    timeSignature: score.timeSignature,
    tempoBpm: score.tempoBpm,
    measureIssues: score.measureIssues ?? []
  };
}

window.__scoreEngine = { receive: (command) => void receive(command) };
window.addEventListener("message", (event: MessageEvent) => {
  const data = typeof event.data === "string" ? safeParse(event.data) : event.data;
  if (data && typeof data === "object" && "type" in data) void receive(data as EngineCommand);
});
// OSMD re-lays out on resize (autoResize); pages are re-sized first (this listener is added before
// OSMD's), and the selection follows the bars.
window.addEventListener("resize", () => {
  sizePages();
  setTimeout(drawSelection, 400);
});

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

send({ type: "ready" });
