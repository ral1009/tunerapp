import { useCallback, useEffect, useRef, useState } from 'react';

import { LiveTuner, type TunerReading } from './liveTuner';
import type { MicStatus } from './micTypes';
import { centsFrom, OPEN_STRINGS } from './notes';
import { useMic } from './useMic';

const EMPTY: TunerReading = { status: 'calibrating', frequencyHz: null, confidence: 0, rms: 0, noiseFloorRms: 0, gain: 1 };
// The last confident pitch stays on screen this long, so the display doesn't blank between strokes.
const HOLD_MS = 900;
// How many recent levels the meter shows.
const LEVEL_HISTORY = 48;

export interface StringState {
  name: string;
  midi: number;
  cents: number | null; // last steady reading on this string
}

export interface TunerState {
  reading: TunerReading;
  heldHz: number | null;
  strings: StringState[];
  currentString: number | null; // index into strings, when an open string is being played
  peakSignalRatio: number; // loudest pitched playing so far, as a multiple of the room's floor
  levels: number[]; // recent raw input levels, oldest first, for a level meter
  micStatus: MicStatus;
  micError: string | null;
  restart: () => void;
}

// Microphone + live pitch for the tuner and the mic check. Everything is worked out in the
// microphone callback (not during render): the pitch, which open string it's nearest (within a
// semitone and a half), and each string's last steady reading -- recorded once four consecutive
// readings agree within 8 cents, so a slide through a string's pitch doesn't count.
export function useTuner(referenceA4: number): TunerState {
  const [reading, setReading] = useState<TunerReading>(EMPTY);
  const [heldHz, setHeldHz] = useState<number | null>(null);
  const [strings, setStrings] = useState<StringState[]>(() => OPEN_STRINGS.map((s) => ({ ...s, cents: null })));
  const [currentString, setCurrentString] = useState<number | null>(null);
  const [peakSignalRatio, setPeakSignalRatio] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const tunerRef = useRef<LiveTuner | null>(null);
  const referenceRef = useRef(referenceA4);

  useEffect(() => {
    referenceRef.current = referenceA4;
  }, [referenceA4]);

  useEffect(() => {
    let lastPitchAt = 0;
    let recent: number[] = [];
    tunerRef.current = new LiveTuner((next) => {
      setReading(next);
      setLevels((prev) => [...prev.slice(-(LEVEL_HISTORY - 1)), next.rms]);
      const now = Date.now();
      if (!next.frequencyHz) {
        recent = [];
        if (now - lastPitchAt > HOLD_MS) {
          setHeldHz(null);
          setCurrentString(null);
        }
        return;
      }
      lastPitchAt = now;
      setHeldHz(next.frequencyHz);
      if (next.noiseFloorRms > 0) setPeakSignalRatio((p) => Math.max(p, next.rms / next.noiseFloorRms));

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
      setCurrentString(best < 0 ? null : best);
      if (best < 0) {
        recent = [];
        return;
      }
      recent = [...recent.slice(-3), bestCents];
      if (recent.length === 4 && Math.max(...recent) - Math.min(...recent) < 8) {
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const index = best;
        setStrings((prev) => prev.map((s, i) => (i === index ? { ...s, cents: mean } : s)));
      }
    });
    return () => {
      tunerRef.current = null;
    };
  }, []);

  const mic = useMic(useCallback((chunk) => tunerRef.current?.push(chunk.samples, chunk.sampleRate), []));
  const { start, stop } = mic;

  useEffect(() => {
    void start();
    return () => stop();
  }, [start, stop]);

  const restart = useCallback(() => {
    tunerRef.current?.reset();
    stop();
    void start();
  }, [start, stop]);

  return { reading, heldHz, strings, currentString, peakSignalRatio, levels, micStatus: mic.status, micError: mic.error, restart };
}

export function currentStringCents(state: TunerState, referenceA4: number): number | null {
  if (state.currentString === null || state.heldHz === null) return null;
  return centsFrom(state.heldHz, OPEN_STRINGS[state.currentString].midi, referenceA4);
}
