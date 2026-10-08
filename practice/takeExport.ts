import type { CursorNoteInfo, QuarterIndexEntry } from "../score/renderer/scoreCursor";
import type { NoteAccuracyRecord } from "./cursor";
import type { AlignmentPoint, OfflineDetectorSetup, OfflineScoringConfig } from "./offlineIntonationScorer";

// A practice take saved for offline diagnosis: everything the post-take scorer used, so a real
// session that went wrong can be replayed exactly (`npm run replayTake -- take.json`) instead of
// being lost when the tab closes. Downloaded as two files: the audio as a 16-bit WAV (exactly the
// samples the alignment server received -- gated-out silence isn't in it) and this JSON.
export interface SavedTake {
  format: "tunerapp-take";
  version: 1;
  savedAt: string;
  sampleRate: number;
  scoreXml: string;
  // Server's post-take alignment; empty if it never arrived (the summary then used live grades).
  path: AlignmentPoint[];
  notes: CursorNoteInfo[];
  quarterIndex: QuarterIndexEntry[];
  detectorSetup: OfflineDetectorSetup;
  scoringConfig: OfflineScoringConfig;
  // Final per-note history the app showed (raw cents against A440; the summary's reference and
  // bands are applied on top -- see practice/reviewSummary.ts).
  history: NoteAccuracyRecord[];
  scoringSource: "offline" | "live" | null;
}

export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

// Browser-only: triggers both downloads. Chrome may ask once whether this site may download
// multiple files.
export function downloadTake(take: SavedTake, audio: Float32Array): void {
  const stamp = take.savedAt.replace(/[:.]/g, "-");
  const save = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  save(new Blob([JSON.stringify(take)], { type: "application/json" }), `take-${stamp}.json`);
  setTimeout(() => save(new Blob([encodeWav16(audio, take.sampleRate).buffer as ArrayBuffer], { type: "audio/wav" }), `take-${stamp}.wav`), 400);
}
