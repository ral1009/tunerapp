// Messages between the native app and the score engine (score/engine/main.ts), the web page that
// renders sheet music inside a WebView (or an iframe in the app's web build). Everything that needs
// a browser DOM -- MusicXML import, OSMD rendering, the cursor, note colours, XML corrections --
// lives in the engine; the app only sends commands and receives results. Plain data both ways.

import type { ScoreMeasureIssue } from "../schema";
import type { CursorNoteInfo, NoteHighlight, QuarterIndexEntry } from "../renderer/scoreCursor";
import type { NoteXmlCorrection } from "../correctionUI/noteXmlCorrection";

export type ScoreTheme = "paper" | "ebony";

export interface ScoreMeta {
  title: string;
  composer: string;
  measureCount: number;
  keySignature: string;
  timeSignature: string;
  tempoBpm: number | null;
  measureIssues: ScoreMeasureIssue[];
}

export interface BarBox {
  measureIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export type EngineCommand =
  | { type: "load"; xml: string; theme: ScoreTheme; render: boolean }
  | { type: "theme"; theme: ScoreTheme }
  | { type: "cursor"; action: "show" | "hide" | "reset" }
  | { type: "seek"; quarter: number }
  | { type: "highlight"; highlights: NoteHighlight[] }
  // Bars drawn as selected (spot practice); null clears. Tapping bars is reported either way.
  | { type: "selectBars"; from: number | null; to: number | null }
  | { type: "scrollToBar"; measureIndex: number }
  // Fix misread notes: patches the MusicXML, re-reads and redraws, and reports the new XML.
  | { type: "correct"; corrections: NoteXmlCorrection[] };

export type EngineEvent =
  | { type: "ready" }
  | { type: "loaded"; meta: ScoreMeta; notes: CursorNoteInfo[]; quarterIndex: QuarterIndexEntry[]; rendered: boolean }
  | { type: "barTap"; measureIndex: number }
  | { type: "cursorMoved"; stepIndex: number | null }
  | { type: "xmlChanged"; xml: string; meta: ScoreMeta; notes: CursorNoteInfo[]; quarterIndex: QuarterIndexEntry[] }
  | { type: "error"; message: string };
