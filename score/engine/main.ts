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
import type { EngineCommand, EngineEvent, ScoreTheme } from "./protocol";

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
let selection: { from: number; to: number } | null = null;
let titleForRender = "";
let composerForRender = "";

function applyTheme(theme: ScoreTheme): void {
  currentTheme = theme;
  document.body.style.background = THEMES[theme].page;
}

async function render(): Promise<void> {
  handle?.unmount();
  handle = await renderScore(currentXml, host, {
    drawTitle: false,
    drawComposer: false,
    drawPartNames: false,
    titleOverride: titleForRender,
    composerOverride: composerForRender || undefined,
    musicColor: THEMES[currentTheme].ink
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

async function grade(command: Extract<EngineCommand, { type: "grade" }>): Promise<void> {
  try {
    const response = await fetch(command.audioUrl);
    if (!response.ok) throw new Error(`couldn't fetch the take from the server (${response.status})`);
    const audio = new Float32Array(await response.arrayBuffer());
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
      case "load": {
        currentXml = command.xml;
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
// OSMD re-lays out on resize (autoResize); keep the selection on the right bars.
window.addEventListener("resize", () => setTimeout(drawSelection, 400));

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

send({ type: "ready" });
