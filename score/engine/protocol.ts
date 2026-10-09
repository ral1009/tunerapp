// Messages between the native app and the score engine (score/engine/main.ts), the web page that
// renders sheet music inside a WebView (or an iframe in the app's web build). Everything that needs
// a browser DOM -- MusicXML import, OSMD rendering, the cursor, note colours, XML corrections --
// lives in the engine; the app only sends commands and receives results. Plain data both ways.

import type { ScoreMeasureIssue } from "../schema";
import type { CursorNoteInfo, NoteHighlight, QuarterIndexEntry } from "../renderer/scoreCursor";
import type { NoteXmlCorrection } from "../correctionUI/noteXmlCorrection";
import type { NoteAccuracyRecord } from "../../practice/cursor";
import type { AlignmentPoint, OfflineDetectorSetup, OfflineScoringConfig } from "../../practice/offlineIntonationScorer";

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
  | { type: "correct"; corrections: NoteXmlCorrection[] }
  // Post-take grading (practice/offlineIntonationScorer). Runs here rather than in the app because
  // the page's JavaScript engine has a JIT and its own thread; the app's (Hermes) has neither, and
  // grading there froze the phone for most of a minute. The take's audio arrives in pieces while
  // it's being played, as 16-bit PCM in base64 (grading is unchanged at 16 bits: see "Download this
  // take" in CLAUDE.md); "grade" at the end joins them, runs the scorer and answers "graded".
  | { type: "gradeAudio"; id: string; pcm16: string }
  | {
      type: "grade";
      id: string;
      path: AlignmentPoint[];
      notes: CursorNoteInfo[];
      quarterIndex: QuarterIndexEntry[];
      setup: OfflineDetectorSetup;
      config: OfflineScoringConfig;
    };

export type EngineEvent =
  | { type: "ready" }
  | { type: "loaded"; meta: ScoreMeta; notes: CursorNoteInfo[]; quarterIndex: QuarterIndexEntry[]; rendered: boolean }
  | { type: "barTap"; measureIndex: number }
  | { type: "cursorMoved"; stepIndex: number | null }
  | { type: "xmlChanged"; xml: string; meta: ScoreMeta; notes: CursorNoteInfo[]; quarterIndex: QuarterIndexEntry[] }
  | { type: "gradeProgress"; id: string; fraction: number }
  | { type: "graded"; id: string; records: NoteAccuracyRecord[] }
  | { type: "gradeFailed"; id: string; message: string }
  | { type: "error"; message: string };
