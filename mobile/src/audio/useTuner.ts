import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { createLiveValue, type LiveValue } from '@/practice/liveValue';

import { LiveTuner, type TunerReading } from './liveTuner';
import type { MicStatus } from './micTypes';
import { centsFrom, OPEN_STRINGS } from './notes';
import { useMic } from './useMic';

const EMPTY: TunerReading = { status: 'calibrating', frequencyHz: null, confidence: 0, rms: 0, noiseFloorRms: 0, gain: 1 };
// The last confident pitch stays on screen this long, so the display doesn't blank between strokes.
const HOLD_MS = 900;
// How many recent levels the meter shows.
const LEVEL_HISTORY = 48;
// Same readout rate as practising (see liveTuner.ts / usePractice.ts): 8 a second, 3-reading median.
const READOUT_INTERVAL_MS = 125;

export interface StringState {
  name: string;
  midi: number;
  cents: number | null; // last steady reading on this string
}

// Everything that changes with each reading, in one snapshot.
export interface TunerSnapshot {
  reading: TunerReading;
  heldHz: number | null;
  strings: StringState[];
  currentString: number | null; // index into strings, when an open string is being played
  peakSignalRatio: number; // loudest pitched playing so far, as a multiple of the room's floor
  levels: number[]; // recent raw input levels, oldest first, for a level meter
}

export interface TunerState {
  // Live readings live outside React state: screens read them through useTunerLive in the small
  // components that show them, so a reading redraws those and not the whole screen.
  live: LiveValue<TunerSnapshot>;
  micStatus: MicStatus;
  micError: string | null;
  restart: () => void;
}

const INITIAL: TunerSnapshot = {
  reading: EMPTY,
  heldHz: null,
  strings: OPEN_STRINGS.map((s) => ({ ...s, cents: null })),
  currentString: null,
  peakSignalRatio: 0,
  levels: [],
};

// Microphone + live pitch for the tuner and the mic check. Everything is worked out in the
// microphone callback (not during render): the pitch, which open string it's nearest (within a
// semitone and a half), and each string's last steady reading -- recorded once four consecutive
// readings agree within 8 cents, so a slide through a string's pitch doesn't count. One snapshot
// update per reading (it used to be up to six separate state updates).
export function useTuner(referenceA4: number): TunerState {
  const [live] = useState(() => createLiveValue<TunerSnapshot>(INITIAL));
  const tunerRef = useRef<LiveTuner | null>(null);
  const referenceRef = useRef(referenceA4);

  useEffect(() => {
    referenceRef.current = referenceA4;
  }, [referenceA4]);

  useEffect(() => {
    let lastPitchAt = 0;
    let recent: number[] = [];
    tunerRef.current = new LiveTuner((next) => {
      const prev = live.get();
      const snap: TunerSnapshot = { ...prev, reading: next, levels: [...prev.levels.slice(-(LEVEL_HISTORY - 1)), next.rms] };
      const now = Date.now();
      if (!next.frequencyHz) {
        recent = [];
        if (now - lastPitchAt > HOLD_MS) {
          snap.heldHz = null;
          snap.currentString = null;
        }
        live.set(snap);
        return;
      }
      lastPitchAt = now;
      snap.heldHz = next.frequencyHz;
      if (next.noiseFloorRms > 0) snap.peakSignalRatio = Math.max(prev.peakSignalRatio, next.rms / next.noiseFloorRms);

      const a4 = referenceRef.current;
      let best = -1;
      let bestCents = 0;
      OPEN_STRINGS.forEach((s, i) => {
        const c = centsFrom(next.frequencyHz as number, s.midi, a4);
        if (Math.abs(c) <= 150 && (best < 0 || Math.abs(c) < Math.abs(bestCents))) {
          best = i;
          bestCents = c;
        }
      });
      snap.currentString = best < 0 ? null : best;
      if (best < 0) {
        recent = [];
      } else {
        recent = [...recent.slice(-3), bestCents];
        if (recent.length === 4 && Math.max(...recent) - Math.min(...recent) < 8) {
          const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
          snap.strings = prev.strings.map((s, i) => (i === best ? { ...s, cents: mean } : s));
        }
      }
      live.set(snap);
    }, READOUT_INTERVAL_MS);
    return () => {
      tunerRef.current = null;
    };
  }, [live]);

  const mic = useMic(useCallback((chunk) => tunerRef.current?.push(chunk.samples, chunk.sampleRate), []));
  const { start, stop } = mic;

  useEffect(() => {
    void start();
    return () => stop();
  }, [start, stop]);

  const restart = useCallback(() => {
    tunerRef.current?.reset();
    live.set(INITIAL);
    stop();
    void start();
  }, [start, stop, live]);

  return { live, micStatus: mic.status, micError: mic.error, restart };
}

// Subscribe to the live tuner. With the default selector the caller redraws on every reading, so
// use it only in the small components that show live values.
export function useTunerLive<T = TunerSnapshot>(live: LiveValue<TunerSnapshot>, select?: (s: TunerSnapshot) => T): T {
  const read = () => (select ? select(live.get()) : (live.get() as unknown as T));
  return useSyncExternalStore(live.subscribe, read, read);
}

export function currentStringCents(state: Pick<TunerSnapshot, 'currentString' | 'heldHz'>, referenceA4: number): number | null {
  if (state.currentString === null || state.heldHz === null) return null;
  return centsFrom(state.heldHz, OPEN_STRINGS[state.currentString].midi, referenceA4);
}
