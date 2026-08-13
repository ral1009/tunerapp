import { YIN } from "pitchfinder";
import { DEFAULT_PREPROCESS_CONFIG, preprocessFrame, type PreprocessConfig } from "./preprocessing";

export interface PitchDetectorConfig {
  preprocess: PreprocessConfig;
  confidenceThreshold: number;
  smoothingWindowFrames: number;
  expectedNoteWindowSemitones: number;
}

export interface PitchDetectionInput {
  samples: Float32Array;
  expectedFrequencyHz?: number;
}

export interface PitchDetectionResult {
  frequencyHz: number | null;
  confidence: number;
  rms: number;
  reason?: "silence" | "low_confidence" | "outside_expected_window" | "detector_no_pitch";
}

const MIN_DETECTABLE_FREQUENCY_HZ = 80;
const MAX_DETECTABLE_FREQUENCY_HZ = 3500;
const OCTAVE_RECOVERY_MIN_HZ = 150;
const OCTAVE_RECOVERY_MAX_HZ = 1500;
const OCTAVE_RECOVERY_MIN_CONFIDENCE = 0.2;
const OCTAVE_RECOVERY_MAX_CONFIDENCE = 0.55;
const OCTAVE_RECOVERY_VALLEY_RATIO = 1.15;
const EXPECTED_NOTE_STABILITY_CONFIDENCE = 0.8;
const EXPECTED_NOTE_STABILITY_SEMITONE_WINDOW = 0.5;

const DEFAULT_CONFIG: PitchDetectorConfig = {
  preprocess: DEFAULT_PREPROCESS_CONFIG,
  confidenceThreshold: 0.6,
  smoothingWindowFrames: 5,
  expectedNoteWindowSemitones: 3
};

class MedianSmoother {
  private readonly maxSize: number;
  private readonly values: number[] = [];

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
  }

  add(value: number): number {
    this.values.push(value);
    if (this.values.length > this.maxSize) {
      this.values.shift();
    }

    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}

function semitoneDelta(fromHz: number, toHz: number): number {
  return 12 * Math.log2(toHz / fromHz);
}

function estimateConfidence(samples: Float32Array, sampleRate: number, frequencyHz: number): number {
  if (frequencyHz <= 0) {
    return 0;
  }

  const lag = Math.round(sampleRate / frequencyHz);
  if (lag <= 0 || lag >= samples.length / 2) {
    return 0;
  }

  let corr = 0;
  let e1 = 0;
  let e2 = 0;
  for (let i = 0; i < samples.length - lag; i += 1) {
    const a = samples[i];
    const b = samples[i + lag];
    corr += a * b;
    e1 += a * a;
    e2 += b * b;
  }

  if (e1 === 0 || e2 === 0) {
    return 0;
  }

  const normalized = corr / Math.sqrt(e1 * e2);
  return Math.max(0, Math.min(1, normalized));
}

function differenceAtLag(samples: Float32Array, lag: number): number {
  if (lag <= 0 || lag >= samples.length) {
    return Number.POSITIVE_INFINITY;
  }

  let sumSquares = 0;
  let count = 0;

  for (let index = 0; index < samples.length - lag; index += 1) {
    const delta = samples[index] - samples[index + lag];
    sumSquares += delta * delta;
    count += 1;
  }

  return count > 0 ? sumSquares / count : Number.POSITIVE_INFINITY;
}

function recoverSubOctaveFrequency(samples: Float32Array, sampleRate: number, frequencyHz: number, confidence: number): number {
  if (
    frequencyHz < OCTAVE_RECOVERY_MIN_HZ ||
    frequencyHz > OCTAVE_RECOVERY_MAX_HZ ||
    confidence < OCTAVE_RECOVERY_MIN_CONFIDENCE ||
    confidence > OCTAVE_RECOVERY_MAX_CONFIDENCE
  ) {
    return frequencyHz;
  }

  const candidateLag = Math.max(1, Math.round(sampleRate / frequencyHz));
  const subOctaveLag = candidateLag * 2;
  if (subOctaveLag >= samples.length) {
    return frequencyHz;
  }

  const primaryValley = differenceAtLag(samples, candidateLag);
  const subOctaveValley = differenceAtLag(samples, subOctaveLag);

  if (!Number.isFinite(primaryValley) || !Number.isFinite(subOctaveValley) || primaryValley <= 0) {
    return frequencyHz;
  }

  return subOctaveValley <= primaryValley * OCTAVE_RECOVERY_VALLEY_RATIO ? frequencyHz / 2 : frequencyHz;
}

function estimateFrequencyInWindow(
  samples: Float32Array,
  sampleRate: number,
  minFrequencyHz: number,
  maxFrequencyHz: number
): { frequencyHz: number | null; confidence: number } {
  const minLag = Math.max(1, Math.floor(sampleRate / maxFrequencyHz));
  const maxLag = Math.min(samples.length - 1, Math.ceil(sampleRate / minFrequencyHz));
  let bestLag = 0;
  let bestCorrelation = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0;
    let energyA = 0;
    let energyB = 0;

    for (let index = 0; index < samples.length - lag; index += 1) {
      const current = samples[index];
      const shifted = samples[index + lag];
      corr += current * shifted;
      energyA += current * current;
      energyB += shifted * shifted;
    }

    if (energyA === 0 || energyB === 0) {
      continue;
    }

    const normalized = corr / Math.sqrt(energyA * energyB);
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized;
      bestLag = lag;
    }
  }

  if (bestLag === 0 || !Number.isFinite(bestCorrelation) || bestCorrelation <= 0) {
    return { frequencyHz: null, confidence: 0 };
  }

  return {
    frequencyHz: sampleRate / bestLag,
    confidence: Math.max(0, Math.min(1, bestCorrelation))
  };
}

function estimateFrequencyAcrossRange(samples: Float32Array, sampleRate: number): { frequencyHz: number | null; confidence: number } {
  return estimateFrequencyInWindow(samples, sampleRate, MIN_DETECTABLE_FREQUENCY_HZ, MAX_DETECTABLE_FREQUENCY_HZ);
}

export class PitchDetector {
  private readonly config: PitchDetectorConfig;
  private readonly yin: (samples: number[] | Float32Array) => number | null;
  private readonly smoother: MedianSmoother;

  constructor(config?: Partial<PitchDetectorConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      preprocess: {
        ...DEFAULT_CONFIG.preprocess,
        ...(config?.preprocess ?? {})
      }
    };

    this.yin = YIN({ sampleRate: this.config.preprocess.sampleRate }) as unknown as (
      samples: number[] | Float32Array
    ) => number | null;
    this.smoother = new MedianSmoother(this.config.smoothingWindowFrames);
  }

  detect(input: PitchDetectionInput): PitchDetectionResult {
    const { gate, processed } = preprocessFrame(input.samples, this.config.preprocess);
    if (!gate.passed) {
      return {
        frequencyHz: null,
        confidence: 0,
        rms: gate.rms,
        reason: "silence"
      };
    }

    if (input.expectedFrequencyHz && input.expectedFrequencyHz > 0) {
      const windowMinHz = input.expectedFrequencyHz * Math.pow(2, -this.config.expectedNoteWindowSemitones / 12);
      const windowMaxHz = input.expectedFrequencyHz * Math.pow(2, this.config.expectedNoteWindowSemitones / 12);
      const windowEstimate = estimateFrequencyInWindow(processed, this.config.preprocess.sampleRate, windowMinHz, windowMaxHz);
      const windowDelta = windowEstimate.frequencyHz
        ? Math.abs(semitoneDelta(input.expectedFrequencyHz, windowEstimate.frequencyHz))
        : Number.POSITIVE_INFINITY;
      if (
        windowEstimate.frequencyHz &&
        (windowEstimate.confidence >= Math.max(this.config.confidenceThreshold, EXPECTED_NOTE_STABILITY_CONFIDENCE) ||
          windowDelta <= EXPECTED_NOTE_STABILITY_SEMITONE_WINDOW)
      ) {
        return {
          frequencyHz: this.smoother.add(windowEstimate.frequencyHz),
          confidence: windowEstimate.confidence,
          rms: gate.rms
        };
      }
    }

    const yinFrequency = this.yin(processed);
    const fallbackEstimate = estimateFrequencyAcrossRange(processed, this.config.preprocess.sampleRate);
    const usesFallbackEstimate =
      !yinFrequency ||
      !Number.isFinite(yinFrequency) ||
      yinFrequency < MIN_DETECTABLE_FREQUENCY_HZ ||
      yinFrequency > MAX_DETECTABLE_FREQUENCY_HZ;
    const rawFrequency = usesFallbackEstimate ? fallbackEstimate.frequencyHz : yinFrequency;

    if (!rawFrequency || !Number.isFinite(rawFrequency)) {
      return {
        frequencyHz: null,
        confidence: 0,
        rms: gate.rms,
        reason: "detector_no_pitch"
      };
    }

    if (rawFrequency < MIN_DETECTABLE_FREQUENCY_HZ || rawFrequency > MAX_DETECTABLE_FREQUENCY_HZ) {
      return {
        frequencyHz: null,
        confidence: 0,
        rms: gate.rms,
        reason: "detector_no_pitch"
      };
    }

    const candidateConfidence = usesFallbackEstimate
      ? fallbackEstimate.confidence
      : estimateConfidence(processed, this.config.preprocess.sampleRate, rawFrequency);
    const correctedFrequency = recoverSubOctaveFrequency(
      processed,
      this.config.preprocess.sampleRate,
      rawFrequency,
      candidateConfidence
    );

    if (input.expectedFrequencyHz && input.expectedFrequencyHz > 0) {
      const delta = Math.abs(semitoneDelta(input.expectedFrequencyHz, correctedFrequency));
      if (delta > this.config.expectedNoteWindowSemitones) {
        return {
          frequencyHz: null,
          confidence: 0,
          rms: gate.rms,
          reason: "outside_expected_window"
        };
      }
    }

    const confidence = estimateConfidence(processed, this.config.preprocess.sampleRate, correctedFrequency);
    if (confidence < this.config.confidenceThreshold) {
      return {
        frequencyHz: null,
        confidence,
        rms: gate.rms,
        reason: "low_confidence"
      };
    }

    if (input.expectedFrequencyHz && input.expectedFrequencyHz > 0) {
      const expectedDelta = Math.abs(semitoneDelta(input.expectedFrequencyHz, correctedFrequency));
      if (
        confidence < Math.max(this.config.confidenceThreshold, EXPECTED_NOTE_STABILITY_CONFIDENCE) &&
        expectedDelta > EXPECTED_NOTE_STABILITY_SEMITONE_WINDOW
      ) {
        return {
          frequencyHz: null,
          confidence,
          rms: gate.rms,
          reason: "low_confidence"
        };
      }
    }

    return {
      frequencyHz: this.smoother.add(correctedFrequency),
      confidence,
      rms: gate.rms
    };
  }
}