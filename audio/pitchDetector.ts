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
      if (windowEstimate.frequencyHz && windowEstimate.confidence >= this.config.confidenceThreshold) {
        return {
          frequencyHz: this.smoother.add(windowEstimate.frequencyHz),
          confidence: windowEstimate.confidence,
          rms: gate.rms
        };
      }
    }

    const rawFrequency = this.yin(processed);
    if (!rawFrequency || !Number.isFinite(rawFrequency)) {
      return {
        frequencyHz: null,
        confidence: 0,
        rms: gate.rms,
        reason: "detector_no_pitch"
      };
    }

    if (input.expectedFrequencyHz && input.expectedFrequencyHz > 0) {
      const delta = Math.abs(semitoneDelta(input.expectedFrequencyHz, rawFrequency));
      if (delta > this.config.expectedNoteWindowSemitones) {
        return {
          frequencyHz: null,
          confidence: 0,
          rms: gate.rms,
          reason: "outside_expected_window"
        };
      }
    }

    const confidence = estimateConfidence(processed, this.config.preprocess.sampleRate, rawFrequency);
    if (confidence < this.config.confidenceThreshold) {
      return {
        frequencyHz: null,
        confidence,
        rms: gate.rms,
        reason: "low_confidence"
      };
    }

    return {
      frequencyHz: this.smoother.add(rawFrequency),
      confidence,
      rms: gate.rms
    };
  }
}