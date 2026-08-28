import { realFftMagnitudes } from "./fft";
import { applyHannWindow } from "./preprocessing";

export interface OnsetDetectorConfig {
  sampleRate: number;
  frameSize: number;
  hopSize: number;
  fluxThreshold: number;
  minOnsetIntervalMs: number;
  // See the spectralConcentration comment in detect() below for why this exists and why it's a
  // ratio (ppm-style peak-vs-mean-bin measure), not an absolute magnitude floor.
  minSpectralConcentration: number;
}

// fluxThreshold is a *normalized* flux (positive spectral-magnitude growth divided by the
// frame's total magnitude) rather than an absolute magnitude sum, so it stays meaningful
// regardless of input loudness/gain -- see detect() below. Starting point only; needs tuning
// against real violin recordings per the plan's §6 methodology (bowed onsets are softer than
// plucked/percussive ones, which is what this whole detector historically over-triggered on).
//
// minSpectralConcentration was added after phase0:validate caught flux alone false-triggering
// on pure broadband noise (confirmed against audio/__tests__/offline-validation/dataset's
// noise-only fixture: normalized flux averaged 0.285, peaking 0.365, close enough to
// fluxThreshold to cross it 10 times over a 3s clip with zero real onsets). Root cause: on
// near-silent noise with no dominant frequency content, per-bin magnitudes fluctuate randomly by
// a large fraction of their own tiny total, so the flux ratio ends up similar in magnitude to a
// real attack's even though nothing tonal is happening. An absolute magnitude floor would "fix"
// this but was deliberately rejected: captureModule/index.ts feeds this detector the UNGAINED
// raw signal specifically so onset behavior stays independent of the per-device software gain
// scalar (a quiet mic/quiet room would then have low absolute magnitude on a genuine onset too,
// and an absolute floor would silently reject it). minSpectralConcentration instead measures how
// much a frame's loudest bin stands out above its own mean bin level (peak / mean) -- a ratio
// entirely internal to one frame, so it stays gain-invariant like fluxThreshold. Diagnosed
// empirically: on the noise fixture's flux>=0.35 frames, concentration never exceeds ~12; on
// every real-onset-scored fixture (synthetic scales, real recorded violin fingered notes) it
// never drops below ~98 at the same flux threshold -- an 8x margin either direction, so 30 is a
// safe cut rather than a tight one.
export const DEFAULT_ONSET_CONFIG: OnsetDetectorConfig = {
  sampleRate: 44_100,
  frameSize: 2048,
  hopSize: 512,
  fluxThreshold: 0.35,
  minOnsetIntervalMs: 70,
  minSpectralConcentration: 30
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
    let peakMagnitude = 0;
    for (let i = 0; i < magnitudes.length; i += 1) {
      const delta = magnitudes[i] - this.previousMagnitudes[i];
      if (delta > 0) {
        positiveDelta += delta;
      }
      totalMagnitude += magnitudes[i];
      if (magnitudes[i] > peakMagnitude) {
        peakMagnitude = magnitudes[i];
      }
    }

    // Normalize by the frame's own total magnitude rather than just bin count: a fixed-scale
    // flux threshold (the old behavior) means a quiet mic can never cross it and a hot/sensitive
    // mic crosses it on ambient noise alone. Dividing by total magnitude makes the threshold a
    // relative "how much did the spectrum's shape change" measure, invariant to overall loudness.
    const flux = totalMagnitude > 0 ? positiveDelta / totalMagnitude : 0;
    // How far the frame's single loudest bin stands out above its own mean bin level -- see
    // minSpectralConcentration's doc comment above for why this exists and why it's a ratio.
    const meanMagnitude = totalMagnitude / magnitudes.length;
    const spectralConcentration = meanMagnitude > 0 ? peakMagnitude / meanMagnitude : 0;
    this.previousMagnitudes = magnitudes;

    const minIntervalMet = timestampMs - this.lastOnsetMs >= this.config.minOnsetIntervalMs;
    const onset =
      minIntervalMet &&
      flux >= this.config.fluxThreshold &&
      spectralConcentration >= this.config.minSpectralConcentration;
    if (onset) {
      this.lastOnsetMs = timestampMs;
    }

    return { onset, flux };
  }
}