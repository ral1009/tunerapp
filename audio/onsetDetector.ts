import { realFftMagnitudes } from "./fft";

export interface OnsetDetectorConfig {
  sampleRate: number;
  frameSize: number;
  hopSize: number;
  fluxThreshold: number;
  minOnsetIntervalMs: number;
}

export const DEFAULT_ONSET_CONFIG: OnsetDetectorConfig = {
  sampleRate: 44_100,
  frameSize: 2048,
  hopSize: 512,
  fluxThreshold: 0.12,
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
    const magnitudes = realFftMagnitudes(frame);
    if (!this.previousMagnitudes) {
      this.previousMagnitudes = magnitudes;
      return { onset: false, flux: 0 };
    }

    let flux = 0;
    for (let i = 0; i < magnitudes.length; i += 1) {
      const delta = magnitudes[i] - this.previousMagnitudes[i];
      if (delta > 0) {
        flux += delta;
      }
    }

    flux /= magnitudes.length;
    this.previousMagnitudes = magnitudes;

    const minIntervalMet = timestampMs - this.lastOnsetMs >= this.config.minOnsetIntervalMs;
    const onset = minIntervalMet && flux >= this.config.fluxThreshold;
    if (onset) {
      this.lastOnsetMs = timestampMs;
    }

    return { onset, flux };
  }
}