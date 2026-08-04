export interface PreprocessConfig {
  sampleRate: number;
  silenceRmsThreshold: number;
  lowCutHz: number;
  highCutHz: number;
}

export const DEFAULT_PREPROCESS_CONFIG: PreprocessConfig = {
  sampleRate: 44_100,
  silenceRmsThreshold: 0.01,
  lowCutHz: 180,
  highCutHz: 3500
};

export interface NoiseGateResult {
  passed: boolean;
  rms: number;
}

export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }

  return Math.sqrt(sumSquares / samples.length);
}

export function applyNoiseGate(samples: Float32Array, threshold: number): NoiseGateResult {
  const rms = calculateRms(samples);
  return {
    passed: rms >= threshold,
    rms
  };
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function createLowPassCoefficients(sampleRate: number, cutoffHz: number, q = 0.707): BiquadCoefficients {
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosOmega = Math.cos(omega);
  const sinOmega = Math.sin(omega);
  const alpha = sinOmega / (2 * q);

  const b0 = (1 - cosOmega) / 2;
  const b1 = 1 - cosOmega;
  const b2 = (1 - cosOmega) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosOmega;
  const a2 = 1 - alpha;

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0
  };
}

function createHighPassCoefficients(sampleRate: number, cutoffHz: number, q = 0.707): BiquadCoefficients {
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosOmega = Math.cos(omega);
  const sinOmega = Math.sin(omega);
  const alpha = sinOmega / (2 * q);

  const b0 = (1 + cosOmega) / 2;
  const b1 = -(1 + cosOmega);
  const b2 = (1 + cosOmega) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosOmega;
  const a2 = 1 - alpha;

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0
  };
}

function runBiquad(samples: Float32Array, coeffs: BiquadCoefficients): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i];
    const y0 = coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return out;
}

export function applyBandPass(samples: Float32Array, sampleRate: number, lowCutHz: number, highCutHz: number): Float32Array {
  const highPassed = runBiquad(samples, createHighPassCoefficients(sampleRate, lowCutHz));
  return runBiquad(highPassed, createLowPassCoefficients(sampleRate, highCutHz));
}

export function applyHannWindow(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  if (samples.length <= 1) {
    return samples.slice();
  }

  for (let i = 0; i < samples.length; i += 1) {
    const coeff = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (samples.length - 1)));
    out[i] = samples[i] * coeff;
  }

  return out;
}

export function preprocessFrame(samples: Float32Array, config: PreprocessConfig = DEFAULT_PREPROCESS_CONFIG): {
  gate: NoiseGateResult;
  processed: Float32Array;
} {
  const gate = applyNoiseGate(samples, config.silenceRmsThreshold);
  if (!gate.passed) {
    return { gate, processed: new Float32Array(samples.length) };
  }

  const filtered = applyBandPass(samples, config.sampleRate, config.lowCutHz, config.highCutHz);
  return {
    gate,
    processed: applyHannWindow(filtered)
  };
}