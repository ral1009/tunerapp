import type { NoteAccuracyRecord } from '@core/practice/cursor';
import { scoreRecordingOffline, type AlignmentPoint, type OfflineDetectorSetup, type OfflineScoringConfig } from '@core/practice/offlineIntonationScorer';
import type { EngineCommand, EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo, QuarterIndexEntry } from '@core/score/renderer/scoreCursor';

// Post-take grading, run in the score engine's page (score/engine) instead of on the app's own
// JavaScript thread. On a phone the app's engine (Hermes) has no JIT: grading a 40-second take
// there took about half a minute even on a laptop with the JIT turned off, with every button dead
// while it ran. The page's engine has a JIT and its own thread.

export interface GradeRequest {
  path: AlignmentPoint[];
  notes: CursorNoteInfo[];
  quarterIndex: QuarterIndexEntry[];
  setup: OfflineDetectorSetup;
  config: OfflineScoringConfig;
  onProgress?: (fraction: number) => void;
}

// One take's audio on its way to the grader: appended as it's recorded (exactly the chunks sent to
// the alignment server, so both share a timeline), graded at the end.
export interface TakeUpload {
  append: (samples: Float32Array) => void;
  grade: (request: GradeRequest) => Promise<NoteAccuracyRecord[]>;
}

export interface Grader {
  startTake: () => TakeUpload;
}

// Grading on the app's own thread -- fine where JavaScript has a JIT; the fallback.
export const inProcessGrader: Grader = {
  startTake: () => {
    const chunks: Float32Array[] = [];
    return {
      append: (samples) => chunks.push(samples),
      grade: (r) => {
        const audio = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          audio.set(c, at);
          at += c.length;
        }
        return scoreRecordingOffline(audio, r.path, r.notes, r.quarterIndex, r.setup, r.config, r.onProgress);
      },
    };
  },
};

// About a second of 48 kHz audio per message: ~128 KB of text, small enough for any bridge, and
// ~40 ms to encode even without a JIT -- spread across the take rather than piled up at its end.
const PIECE_SAMPLES = 48000;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0));
const EQUALS = 61;

// 16-bit little-endian PCM as base64, built as character codes and turned into a string in
// slices: string concatenation per character is what made this slow without a JIT.
function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const v = Math.round((s > 1 ? 1 : s < -1 ? -1 : s) * 32767) & 0xffff;
    bytes[2 * i] = v & 0xff;
    bytes[2 * i + 1] = v >> 8;
  }
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out[o] = B64_CODES[a >> 2];
    out[o + 1] = B64_CODES[((a & 3) << 4) | (b >> 4)];
    out[o + 2] = i + 1 < bytes.length ? B64_CODES[((b & 15) << 2) | (c >> 6)] : EQUALS;
    out[o + 3] = i + 2 < bytes.length ? B64_CODES[c & 63] : EQUALS;
    o += 4;
  }
  const parts: string[] = [];
  for (let i = 0; i < out.length; i += 8192) parts.push(String.fromCharCode.apply(null, out.subarray(i, i + 8192) as unknown as number[]));
  return parts.join('');
}

// Created once per screen; attach() connects it to the score view once that exists.
// Created once per screen; attach() connects it to the score view once that exists.
export function createEngineGrader() {
  let send: (command: EngineCommand) => void = () => undefined;
  const pending = new Map<string, { resolve: (r: NoteAccuracyRecord[]) => void; reject: (e: Error) => void; onProgress?: (f: number) => void }>();
  let counter = 0;

  const startTake = (): TakeUpload => {
    counter += 1;
    const id = `take-${Date.now().toString(36)}-${counter}`;
    let buffered: Float32Array[] = [];
    let bufferedLength = 0;
    const flush = () => {
      if (bufferedLength === 0) return;
      const piece = new Float32Array(bufferedLength);
      let at = 0;
      for (const c of buffered) {
        piece.set(c, at);
        at += c.length;
      }
      buffered = [];
      bufferedLength = 0;
      send({ type: 'gradeAudio', id, pcm16: pcm16Base64(piece) });
    };
    return {
      append: (samples) => {
        buffered.push(samples);
        bufferedLength += samples.length;
        if (bufferedLength >= PIECE_SAMPLES) flush();
      },
      grade: (request) => {
        flush();
        const result = new Promise<NoteAccuracyRecord[]>((resolve, reject) => pending.set(id, { resolve, reject, onProgress: request.onProgress }));
        send({ type: 'grade', id, path: request.path, notes: request.notes, quarterIndex: request.quarterIndex, setup: request.setup, config: request.config });
        return result;
      },
    };
  };

  // Feed every engine event through this; returns true if it was a grading event.
  const handle = (event: EngineEvent): boolean => {
    if (event.type === 'gradeProgress') {
      pending.get(event.id)?.onProgress?.(event.fraction);
      return true;
    }
    if (event.type === 'graded' || event.type === 'gradeFailed') {
      const entry = pending.get(event.id);
      pending.delete(event.id);
      if (event.type === 'graded') entry?.resolve(event.records);
      else entry?.reject(new Error(event.message));
      return true;
    }
    return false;
  };

  const attach = (to: (command: EngineCommand) => void) => {
    send = to;
  };

  const grader: Grader = { startTake };
  return { grader, handle, attach };
}
