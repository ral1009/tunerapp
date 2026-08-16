import { realFftMagnitudes } from "./fft";
import { applyHannWindow } from "./preprocessing";

export interface OnsetDetectorConfig {
  sampleRate: number;
  frameSize: number;
  hopSize: number;
  fluxThreshold: number;
  minOnsetIntervalMs: number;
}

// fluxThreshold is a *normalized* flux (positive spectral-magnitude growth divided by the
// frame's total magnitude) rather than an absolute magnitude sum, so it stays meaningful
// regardless of input loudness/gain -- see detect() below. Starting point only; needs tuning
// against real violin recordings per the plan's §6 methodology (bowed onsets are softer than
// plucked/percussive ones, which is what this whole detector historically over-triggered on).
export const DEFAULT_ONSET_CONFIG: OnsetDetectorConfig = {
  sampleRate: 44_100,
  frameSize: 2048,
  hopSize: 512,
  fluxThreshold: 0.35,
  minOnsetIntervalMs: 70
};

export class OnsetDetector {
  private readonly config: OnsetDetectorConfig;
  private previousMagnitudes: Float32Array | null = null;
  private lastOnsetMs = -Infinity;

  constructor(config?: Partial<OnsetDetectorConfig>) {
    this.config = { ...DEFAULT_ONSET_CONFIG, ...config };
  }

  detect(frame: Float32Array, timestampMs: number): { onset: boolean; flux: number } {
    // Windowed before FFT (previously wasn't) -- an unwindowed FFT leaks energy across bins on
    // every frame, which inflates frame-to-frame magnitude deltas and was a source of spurious
    // flux unrelated to any real onset.
    const magnitudes = realFftMagnitudes(applyHannWindow(frame));
    if (!this.previousMagnitudes) {
      this.previousMagnitudes = magnitudes;
      return { onset: false, flux: 0 };
    }

    let positiveDelta = 0;
    let totalMagnitude = 0;
    for (let i = 0; i < magnitudes.length; i += 1) {
      const delta = magnitudes[i] - this.previousMagnitudes[i];
      if (delta > 0) {
        positiveDelta += delta;
      }
      totalMagnitude += magnitudes[i];
    }

    // Normalize by the frame's own total magnitude rather than just bin count: a fixed-scale
    // flux threshold (the old behavior) means a quiet mic can never cross it and a hot/sensitive
    // mic crosses it on ambient noise alone. Dividing by total magnitude makes the threshold a
    // relative "how much did the spectrum's shape change" measure, invariant to overall loudness.
    const flux = totalMagnitude > 0 ? positiveDelta / totalMagnitude : 0;
    this.previousMagnitudes = magnitudes;

    const minIntervalMet = timestampMs - this.lastOnsetMs >= this.config.minOnsetIntervalMs;
    const onset = minIntervalMet && flux >= this.config.fluxThreshold;
    if (onset) {
      this.lastOnsetMs = timestampMs;
    }

    return { onset, flux };
  }
}