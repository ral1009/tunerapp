import type { NoteAccuracyRecord } from '@core/practice/cursor';
import type { AlignmentPoint, OfflineDetectorSetup, OfflineScoringConfig } from '@core/practice/offlineIntonationScorer';
import type { EngineCommand, EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo, QuarterIndexEntry } from '@core/score/renderer/scoreCursor';

// Post-take grading, run in the score engine's page (score/engine) instead of on the app's own
// JavaScript thread. On a phone the app's engine (Hermes) has no JIT: grading a 40-second take
// there took about half a minute even on a laptop with the JIT turned off, with every button dead
// while it ran. The page's engine has a JIT and its own thread, and it fetches the take's audio
// straight from the alignment server, so the phone doesn't encode or forward any of it.

export interface GradeRequest {
  audioUrl: string;
  path: AlignmentPoint[];
  notes: CursorNoteInfo[];
  quarterIndex: QuarterIndexEntry[];
  setup: OfflineDetectorSetup;
  config: OfflineScoringConfig;
  onProgress?: (fraction: number) => void;
}

export type Grader = (request: GradeRequest) => Promise<NoteAccuracyRecord[]>;

// Created once per screen; attach() connects it to the score view once that exists.
export function createEngineGrader() {
  let send: (command: EngineCommand) => void = () => undefined;
  const pending = new Map<string, { resolve: (r: NoteAccuracyRecord[]) => void; reject: (e: Error) => void; onProgress?: (f: number) => void }>();
  let counter = 0;

  const grade: Grader = ({ onProgress, ...request }) => {
    counter += 1;
    const id = `grade-${Date.now().toString(36)}-${counter}`;
    const result = new Promise<NoteAccuracyRecord[]>((resolve, reject) => pending.set(id, { resolve, reject, onProgress }));
    send({ type: 'grade', id, ...request });
    return result;
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

  return { grade, handle, attach };
}
