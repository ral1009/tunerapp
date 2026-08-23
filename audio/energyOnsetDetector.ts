export interface EnergyOnsetDetectorConfig {
  minOnsetIntervalMs: number;
  // Minimum relative RMS rise (this frame's RMS vs the previous frame's, as a fraction of the
  // previous frame's RMS) to count as an onset -- see detect() below. "Informed but not certain,"
  // same as OnsetDetector's fluxThreshold: a starting point, needs live tuning.
  rmsRiseThreshold: number;
  // Frames with RMS below this are never treated as onsets regardless of relative rise -- guards
  // against a rise ratio computed from near-silence (previousRms ~ 0) producing a huge,
  // meaningless spike.
  minRms: number;
}

// minOnsetIntervalMs matches OnsetDetector's default for consistency between the two detectors
// feeding the same fusion window in audio/captureModule/index.ts.
export const DEFAULT_ENERGY_ONSET_CONFIG: EnergyOnsetDetectorConfig = {
  minOnsetIntervalMs: 70,
  rmsRiseThreshold: 0.6,
  minRms: 0.005
};

// Detects an onset via the RMS envelope's frame-to-frame RISE, independent of OnsetDetector's
// spectral-flux (spectral SHAPE change) analysis -- a genuine bow attack usually produces both,
// but not always: a same-pitch re-articulation (bowing the same note again) can have a smaller
// spectral-shape change than a fresh loudness transient, since the spectral content is already
// similar to what came before. Mirrors OnsetDetector's shape (stateful, one frame at a time, no
// external dependencies) so it composes the same way and the two can be fused by a caller.
export class EnergyOnsetDetector {
  private readonly config: EnergyOnsetDetectorConfig;
  private previousRms: number | null = null;
  private lastOnsetMs = -Infinity;

  constructor(config?: Partial<EnergyOnsetDetectorConfig>) {
    this.config = { ...DEFAULT_ENERGY_ONSET_CONFIG, ...config };
  }

  // Takes an already-computed RMS value rather than raw samples -- callers already compute RMS
  // for other purposes (the silence gate, calibration) on the same window this should analyze, so
  // this avoids a redundant pass over the samples.
  detect(rms: number, timestampMs: number): { onset: boolean; rise: number } {
    if (this.previousRms === null) {
      this.previousRms = rms;
      return { onset: false, rise: 0 };
    }

    const rise = this.previousRms > 0 ? (rms - this.previousRms) / this.previousRms : 0;
    this.previousRms = rms;

    const minIntervalMet = timestampMs - this.lastOnsetMs >= this.config.minOnsetIntervalMs;
    const onset = minIntervalMet && rms >= this.config.minRms && rise >= this.config.rmsRiseThreshold;
    if (onset) {
      this.lastOnsetMs = timestampMs;
    }

    return { onset, rise };
  }
}
