import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { NoteAccuracyRecord } from '@core/practice/cursor';
import { gradeTake, gradingOptions } from '@core/practice/reviewSummary';
import type { GradeReference, GradeStrictness } from '@core/practice/reviewSummary';

// Every graded take, saved on the device: what progress, the bars-that-need-work strip and
// "practise next" are built from. Records hold raw cents against A440 (as the followers store
// them), so a take can be re-graded against any reference or strictness later.
export interface Take {
  id: string;
  pieceId: string;
  at: number;
  // Spot practice: the bars looped (1-based); null for the whole piece.
  region: { fromBar: number; toBar: number } | null;
  // 'offline' = graded from the server's post-take alignment; 'live' = the server never replied.
  source: 'offline' | 'live';
  records: NoteAccuracyRecord[];
}

const STORAGE_KEY = 'tunerapp.takes.v1';
// Keep the newest takes per piece; older ones only feed the progress line, which needs a handful.
const MAX_TAKES_PER_PIECE = 40;

interface TakesValue {
  takes: Take[];
  add: (take: Omit<Take, 'id' | 'at'>) => string;
  forPiece: (pieceId: string) => Take[];
  get: (id: string) => Take | undefined;
}

const TakesContext = createContext<TakesValue | null>(null);

export function TakesProvider({ children }: { children: ReactNode }) {
  const [takes, setTakes] = useState<Take[]>([]);
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => raw && setTakes(JSON.parse(raw)))
      .catch(() => undefined);
  }, []);

  const value = useMemo<TakesValue>(
    () => ({
      takes,
      get: (id) => takes.find((t) => t.id === id),
      forPiece: (pieceId) => takes.filter((t) => t.pieceId === pieceId).sort((a, b) => b.at - a.at),
      add: (take) => {
        const id = `take-${Date.now().toString(36)}`;
        setTakes((prev) => {
          const full = { ...take, id, at: Date.now() };
          const mine = [full, ...prev.filter((t) => t.pieceId === take.pieceId)].slice(0, MAX_TAKES_PER_PIECE);
          const next = [...prev.filter((t) => t.pieceId !== take.pieceId), ...mine];
          AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
          return next;
        });
        return id;
      },
    }),
    [takes],
  );
  return <TakesContext.Provider value={value}>{children}</TakesContext.Provider>;
}

export function useTakes(): TakesValue {
  const value = useContext(TakesContext);
  if (!value) throw new Error('useTakes must be used inside TakesProvider');
  return value;
}

// In-tune share of the notes that were graded, as a whole percentage (null if nothing graded).
export function takeScore(take: Take, reference: GradeReference, strictness: GradeStrictness): number | null {
  const graded = gradeTake(take.records, gradingOptions(reference, strictness)).records.filter(
    (r) => r.verdict === 'in_tune' || r.verdict === 'close' || r.verdict === 'out_of_tune',
  );
  if (graded.length === 0) return null;
  return Math.round((100 * graded.filter((r) => r.verdict === 'in_tune').length) / graded.length);
}
