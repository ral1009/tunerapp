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
  reason?: "silence" | "low_confidence" | "outside_expected_window" | "detector_no_pitch" | "outside_violin_range";
}

// Bounds the detector's internal search/YIN-acceptance range (fallback autocorrelation window,
// YIN-vs-fallback selection, expected-frequency-hint clamping). Deliberately wider than the
// violin's actual playable range -- bowed strings often have a weak fundamental and strong
// harmonics, and the octave-disambiguation heuristics below need that extra headroom to correctly
// find the true fundamental. Narrowing this to the violin's real range was tried and measurably
// broke octave accuracy on the offline validation dataset (steady accuracy 97%->92%, octave errors
// 0->134) -- use VALID_NOTE_MIN/MAX_FREQUENCY_HZ below instead for output plausibility filtering.
const MIN_DETECTABLE_FREQUENCY_HZ = 80;
const MAX_DETECTABLE_FREQUENCY_HZ = 3500;
// Violin's open G string (lowest playable note) is 196.00Hz. This is a separate, tighter *output*
// plausibility check applied only to the final note the detector is about to report -- anything
// below this is definitionally not a violin note (voice, room rumble, coughing). Set a semitone or
// so under G3 rather than exactly at it: a hard floor at exactly 196 clipped legitimate open-G
// readings on the offline validation dataset (steady accuracy 97%->85%, latency 33ms->147ms) --
// discrete-lag frequency estimation naturally jitters a few Hz around the true value, and G3 has no
// room below it to absorb that when the floor sits right on top of it. The ceiling stays
// equal to MAX_DETECTABLE_FREQUENCY_HZ (not tightened further) -- the offline validation dataset
// has a fixture (synthetic-high-g7.wav) that intentionally exercises detection up to G7 (~3136Hz),
// above even the C7/E7 range that noise was being misdetected into, so a lower ceiling here would
// reject genuine extreme-high-position/harmonic playing along with the noise. Rejecting spurious
// high-frequency noise needs a confidence-side fix instead, not a range cutoff.
const VALID_NOTE_MIN_FREQUENCY_HZ = 185;
const VALID_NOTE_MAX_FREQUENCY_HZ = MAX_DETECTABLE_FREQUENCY_HZ;
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

function isPlausibleViolinFrequency(frequencyHz: number): boolean {
  return frequencyHz >= VALID_NOTE_MIN_FREQUENCY_HZ && frequencyHz <= VALID_NOTE_MAX_FREQUENCY_HZ;
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

    // A caller-supplied expected frequency outside the violin's playable range (this app is
    // violin-only, MIN_DETECTABLE_FREQUENCY_HZ-MAX_DETECTABLE_FREQUENCY_HZ) is never useful to
    // narrow a search around or reject a reading against -- it's necessarily wrong (e.g. an OMR
    // octave misread several octaves off), and treating it as real previously meant narrowing the
    // whole search to a physically-impossible band, guaranteeing every real note got rejected.
    // Falls back to an unrestricted search in that case, same as no expected frequency at all.
    const expectedFrequencyHz =
      input.expectedFrequencyHz &&
      input.expectedFrequencyHz >= MIN_DETECTABLE_FREQUENCY_HZ &&
      input.expectedFrequencyHz <= MAX_DETECTABLE_FREQUENCY_HZ
        ? input.expectedFrequencyHz
        : undefined;

    if (expectedFrequencyHz) {
      const windowMinHz = expectedFrequencyHz * Math.pow(2, -this.config.expectedNoteWindowSemitones / 12);
      const windowMaxHz = expectedFrequencyHz * Math.pow(2, this.config.expectedNoteWindowSemitones / 12);
      const windowEstimate = estimateFrequencyInWindow(processed, this.config.preprocess.sampleRate, windowMinHz, windowMaxHz);
      const windowDelta = windowEstimate.frequencyHz
        ? Math.abs(semitoneDelta(expectedFrequencyHz, windowEstimate.frequencyHz))
        : Number.POSITIVE_INFINITY;
      // windowDelta <= EXPECTED_NOTE_STABILITY_SEMITONE_WINDOW is a *relaxation* of the normal
      // confidence bar (down from EXPECTED_NOTE_STABILITY_CONFIDENCE to just confidenceThreshold)
      // for a reading that lands very close to the expected pitch -- it must never be a bypass of
      // confidence checking entirely. A narrow-band search has few competing lags, so pure noise
      // regularly finds *some* "best" candidate inside the band, and that candidate landing near
      // the band's own center (the expected frequency) by chance was previously enough to accept
      // it with zero confidence evidence -- this is what let ambient noise register as a
      // confidently-detected note once a score's expected pitch narrowed the search.
      if (
        windowEstimate.frequencyHz &&
        isPlausibleViolinFrequency(windowEstimate.frequencyHz) &&
        windowEstimate.confidence >= this.config.confidenceThreshold &&
        (windowEstimate.confidence >= EXPECTED_NOTE_STABILITY_CONFIDENCE || windowDelta <= EXPECTED_NOTE_STABILITY_SEMITONE_WINDOW)
      ) {
        return {
          frequencyHz: this.smoother.add(windowEstimate.frequencyHz),
          confidence: windowEstimate.confidence,
          rms: gate.rms
        };
      }
    }

    const yinFrequency = this.yin(processed);
    const usesFallbackEstimate =
      !yinFrequency ||
      !Number.isFinite(yinFrequency) ||
      yinFrequency < MIN_DETECTABLE_FREQUENCY_HZ ||
      yinFrequency > MAX_DETECTABLE_FREQUENCY_HZ;
    // Only run the brute-force full-range autocorrelation (an O(lag range * frame length) search,
    // ~587 candidate lags at 48kHz -- easily the single most expensive step in detect()) when YIN
    // actually needs backup. Previously this ran unconditionally every frame and its result was
    // discarded whenever YIN succeeded (the common case during normal playing), which was the
    // dominant cause of the pipeline falling behind real-time on fast passages / weaker CPUs.
    const fallbackEstimate = usesFallbackEstimate
      ? estimateFrequencyAcrossRange(processed, this.config.preprocess.sampleRate)
      : null;
    const rawFrequency = usesFallbackEstimate ? fallbackEstimate!.frequencyHz : yinFrequency;

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
      ? fallbackEstimate!.confidence
      : estimateConfidence(processed, this.config.preprocess.sampleRate, rawFrequency);
    const correctedFrequency = recoverSubOctaveFrequency(
      processed,
      this.config.preprocess.sampleRate,
      rawFrequency,
      candidateConfidence
    );

    if (!isPlausibleViolinFrequency(correctedFrequency)) {
      return {
        frequencyHz: null,
        confidence: 0,
        rms: gate.rms,
        reason: "outside_violin_range"
      };
    }

    if (expectedFrequencyHz) {
      const delta = Math.abs(semitoneDelta(expectedFrequencyHz, correctedFrequency));
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

    if (expectedFrequencyHz) {
      const expectedDelta = Math.abs(semitoneDelta(expectedFrequencyHz, correctedFrequency));
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