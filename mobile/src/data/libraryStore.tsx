import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ScoreMeasureIssue } from '@core/score/schema';

import { SAMPLE_SCORES } from './samples';

// The player's pieces, saved on the device. Each keeps its MusicXML (the score engine renders and
// reads it) plus what the engine reported when it was added. Takes and progress come with step 4.
export interface Piece {
  id: string;
  title: string;
  composer: string;
  xml: string;
  source: 'photo' | 'file' | 'sample';
  addedAt: number;
  openedAt: number | null;
  measureCount: number;
  measureIssues: ScoreMeasureIssue[]; // bars that don't add up -- usually photo misreads
}

const STORAGE_KEY = 'tunerapp.library.v1';

const SAMPLES: Piece[] = [
  { id: 'sample-twinkle', title: 'Twinkle, Twinkle', composer: 'Traditional', measureCount: 12, xml: SAMPLE_SCORES[0].xml },
  { id: 'sample-d-scale', title: 'D major scale', composer: 'Warm-up', measureCount: 4, xml: SAMPLE_SCORES[1].xml },
].map((p, i) => ({ ...p, source: 'sample' as const, addedAt: i, openedAt: null, measureIssues: [] }));

interface LibraryValue {
  pieces: Piece[];
  loaded: boolean;
  add: (piece: Omit<Piece, 'id' | 'addedAt' | 'openedAt'>) => string;
  update: (id: string, patch: Partial<Piece>) => void;
  remove: (id: string) => void;
  get: (id: string) => Piece | undefined;
  // The piece to offer under "Continue": the last one opened, else the newest.
  current: Piece | undefined;
}

const LibraryContext = createContext<LibraryValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [pieces, setPieces] = useState<Piece[]>(SAMPLES);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) setPieces(JSON.parse(raw));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const value = useMemo<LibraryValue>(() => {
    const save = (next: Piece[]) => {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    };
    const sorted = [...pieces].sort((a, b) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt));
    return {
      pieces: sorted,
      loaded,
      current: sorted[0],
      get: (id) => pieces.find((p) => p.id === id),
      add: (piece) => {
        const id = `piece-${Date.now().toString(36)}`;
        setPieces((prev) => save([...prev, { ...piece, id, addedAt: Date.now(), openedAt: null }]));
        return id;
      },
      update: (id, patch) => setPieces((prev) => save(prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))),
      remove: (id) => setPieces((prev) => save(prev.filter((p) => p.id !== id))),
    };
  }, [pieces, loaded]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used inside LibraryProvider');
  return value;
}

// Engraved-style caps for a page thumbnail ("TWINKLE, TWINKLE").
export function pageCaps(piece: Piece): string {
  return piece.title.toUpperCase().slice(0, 22);
}
