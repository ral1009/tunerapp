import { PitchDetector } from '@core/audio/pitchDetector';
import { calculateRms } from '@core/audio/preprocessing';

// Turns microphone chunks into pitch readings with the web app's own PitchDetector, configured
// and calibrated exactly like audio/captureModule (same frame-size rule, confidence 0.67, band
// 80-3500 Hz, 500 ms noise-floor calibration with the same gate ratio and gain cap), so the phone
// and the browser read the same violin the same way.

const CONFIDENCE_THRESHOLD = 0.67;
const SMOOTHING_FRAMES = 5;
const CALIBRATION_WINDOW_MS = 500;
const CALIBRATION_GATE_RATIO = 1.5;
const CALIBRATION_GATE_FLOOR_RMS = 0.00002;
const CALIBRATION_GAIN_TARGET_RMS = 0.05;
const CALIBRATION_GAIN_EPSILON_RMS = 0.0005;
const MAX_GAIN_SCALAR = 32;

export interface TunerReading {
  status: 'calibrating' | 'listening';
  frequencyHz: number | null;
  confidence: number;
  rms: number; // raw input level, before gain
  noiseFloorRms: number;
  gain: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

export class LiveTuner {
  private sampleRate = 0;
  private frameSize = 4096;
  private readonly hopSize: number;
  private buffer = new Float32Array(0);
  private detector: PitchDetector | null = null;
  private calibrationRms: number[] = [];
  private calibrationSamples = 0;
  private gain = 1;
  private noiseFloor = 0;
  private calibrated = false;

  constructor(private readonly onReading: (reading: TunerReading) => void, hopSize = 2048) {
    this.hopSize = hopSize;
  }

  reset(): void {
    this.sampleRate = 0;
    this.buffer = new Float32Array(0);
    this.detector = null;
    this.calibrationRms = [];
    this.calibrationSamples = 0;
    this.gain = 1;
    this.calibrated = false;
  }

  push(samples: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.sampleRate) {
      this.reset();
      this.sampleRate = sampleRate;
      this.frameSize = sampleRate >= 48000 ? 4096 : 2048;
    }
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;

    while (this.buffer.length >= this.frameSize) {
      this.analyse(this.buffer.slice(0, this.frameSize));
      this.buffer = this.buffer.slice(this.hopSize);
    }
  }

  private analyse(frame: Float32Array): void {
    const rms = calculateRms(frame);
    if (!this.calibrated) {
      this.calibrationRms.push(rms);
      this.calibrationSamples += this.hopSize;
      const floor = median(this.calibrationRms);
      this.noiseFloor = floor;
      if ((this.calibrationSamples / this.sampleRate) * 1000 < CALIBRATION_WINDOW_MS) {
        this.onReading({ status: 'calibrating', frequencyHz: null, confidence: 0, rms, noiseFloorRms: floor, gain: 1 });
        return;
      }
      const rawThreshold = Math.max(CALIBRATION_GATE_FLOOR_RMS, floor * CALIBRATION_GATE_RATIO);
      this.gain = Math.max(1, Math.min(MAX_GAIN_SCALAR, CALIBRATION_GAIN_TARGET_RMS / Math.max(CALIBRATION_GAIN_EPSILON_RMS, floor)));
      this.detector = new PitchDetector({
        preprocess: { sampleRate: this.sampleRate, silenceRmsThreshold: rawThreshold * this.gain, lowCutHz: 80, highCutHz: 3500 },
        confidenceThreshold: CONFIDENCE_THRESHOLD,
        smoothingWindowFrames: SMOOTHING_FRAMES,
        expectedNoteWindowSemitones: 3,
      });
      this.calibrated = true;
    }
    const gained = this.gain === 1 ? frame : frame.map((s) => s * this.gain);
    const result = (this.detector as PitchDetector).detect({ samples: gained });
    this.onReading({
      status: 'listening',
      frequencyHz: result.frequencyHz,
      confidence: result.confidence,
      rms,
      noiseFloorRms: this.noiseFloor,
      gain: this.gain,
    });
  }
}
