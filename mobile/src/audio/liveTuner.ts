import { PitchDetector } from '@core/audio/pitchDetector';
import { calculateRms } from '@core/audio/preprocessing';

// Turns microphone chunks into live pitch readings with the web app's own PitchDetector
// (confidence 0.67, band 80-3500 Hz, 500 ms noise-floor calibration with the capture module's
// gate ratio and gain cap) -- tuned for a phone, where JavaScript runs without a JIT:
//
// - Analysed at ~24 kHz (the microphone's rate divided down by a whole number, averaging each
//   group of samples) on a 1024-sample window. On the Twinkle recording this reads within 0.5¢
//   (median) of the full-rate 4096-sample setup at a fourteenth of the cost; without a JIT the
//   full-rate frame took ~42 ms on a laptop, and a phone running it 23 times a second fell
//   further behind with every note -- the "10 seconds to notice a note" lag, with the UI frozen.
// - Only ever the newest audio: at most one reading per interval, from the latest window. If the
//   phone falls behind, old audio is skipped, never queued.
// - The interval widens by itself if a reading takes more than a third of it.
//
// This is the live readout only. Grading uses the full-rate recording after the take.

const CONFIDENCE_THRESHOLD = 0.67;
// Median of the last 3 readings. Judged against known pitches (.scratch/eval_readout.ts): same
// accuracy as 5 (0.6¢ median, 1.4¢ p90) but a new note shows after ~220 ms instead of ~340 ms.
const SMOOTHING_FRAMES = 3;
const CALIBRATION_WINDOW_MS = 500;
const CALIBRATION_GATE_RATIO = 1.5;
const CALIBRATION_GATE_FLOOR_RMS = 0.00002;
const CALIBRATION_GAIN_TARGET_RMS = 0.05;
const CALIBRATION_GAIN_EPSILON_RMS = 0.0005;
const MAX_GAIN_SCALAR = 32;
const ANALYSIS_RATE_HZ = 24000;
const FRAME_SIZE = 1024;
const MAX_INTERVAL_MS = 250;

export interface TunerReading {
  status: 'calibrating' | 'listening';
  frequencyHz: number | null;
  confidence: number;
  rms: number; // input level of the analysed window, before gain
  noiseFloorRms: number;
  gain: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class LiveTuner {
  private inputRate = 0;
  private factor = 1;
  // The newest FRAME_SIZE samples at the analysis rate, as a ring.
  private ring = new Float32Array(FRAME_SIZE);
  private ringPos = 0;
  private filled = 0;
  private carry = 0; // partial sum of input samples not yet a whole decimated sample
  private carryCount = 0;
  private sinceReading = 0; // analysis-rate samples since the last reading
  private interval: number;
  private detector: PitchDetector | null = null;
  private calibrationRms: number[] = [];
  private calibratedSamples = 0;
  private gain = 1;
  private noiseFloor = 0;
  private calibrated = false;

  constructor(private readonly onReading: (reading: TunerReading) => void, private readonly minIntervalMs = 60) {
    this.interval = minIntervalMs;
  }

  reset(): void {
    this.inputRate = 0;
    this.ringPos = 0;
    this.filled = 0;
    this.carry = 0;
    this.carryCount = 0;
    this.sinceReading = 0;
    this.interval = this.minIntervalMs;
    this.detector = null;
    this.calibrationRms = [];
    this.calibratedSamples = 0;
    this.gain = 1;
    this.calibrated = false;
  }

  private get rate(): number {
    return this.inputRate / this.factor;
  }

  push(samples: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.inputRate) {
      this.reset();
      this.inputRate = sampleRate;
      this.factor = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE_HZ));
    }
    const f = this.factor;
    for (let i = 0; i < samples.length; i += 1) {
      this.carry += samples[i];
      this.carryCount += 1;
      if (this.carryCount === f) {
        this.ring[this.ringPos] = this.carry / f;
        this.ringPos = (this.ringPos + 1) % FRAME_SIZE;
        if (this.filled < FRAME_SIZE) this.filled += 1;
        this.sinceReading += 1;
        this.carry = 0;
        this.carryCount = 0;
      }
    }
    if (this.filled < FRAME_SIZE) return;
    if ((this.sinceReading / this.rate) * 1000 < this.interval) return;
    const elapsed = this.sinceReading;
    this.sinceReading = 0;
    this.analyse(this.latestFrame(), elapsed);
  }

  private latestFrame(): Float32Array {
    const frame = new Float32Array(FRAME_SIZE);
    const head = FRAME_SIZE - this.ringPos;
    frame.set(this.ring.subarray(this.ringPos), 0);
    frame.set(this.ring.subarray(0, this.ringPos), head);
    return frame;
  }

  private analyse(frame: Float32Array, elapsedSamples: number): void {
    const rms = calculateRms(frame);
    if (!this.calibrated) {
      this.calibrationRms.push(rms);
      this.calibratedSamples += elapsedSamples;
      const floor = median(this.calibrationRms);
      this.noiseFloor = floor;
      if ((this.calibratedSamples / this.rate) * 1000 < CALIBRATION_WINDOW_MS) {
        this.onReading({ status: 'calibrating', frequencyHz: null, confidence: 0, rms, noiseFloorRms: floor, gain: 1 });
        return;
      }
      const rawThreshold = Math.max(CALIBRATION_GATE_FLOOR_RMS, floor * CALIBRATION_GATE_RATIO);
      this.gain = Math.max(1, Math.min(MAX_GAIN_SCALAR, CALIBRATION_GAIN_TARGET_RMS / Math.max(CALIBRATION_GAIN_EPSILON_RMS, floor)));
      this.detector = new PitchDetector({
        preprocess: { sampleRate: this.rate, silenceRmsThreshold: rawThreshold * this.gain, lowCutHz: 80, highCutHz: 3500 },
        confidenceThreshold: CONFIDENCE_THRESHOLD,
        smoothingWindowFrames: SMOOTHING_FRAMES,
        expectedNoteWindowSemitones: 3,
      });
      this.calibrated = true;
    }
    if (this.gain !== 1) for (let i = 0; i < frame.length; i += 1) frame[i] *= this.gain;
    const started = now();
    const result = (this.detector as PitchDetector).detect({ samples: frame });
    const took = now() - started;
    // Keep the readout to at most a third of the time: a slow phone gets fewer readings, not a backlog.
    this.interval = Math.min(MAX_INTERVAL_MS, Math.max(this.minIntervalMs, took * 3));
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
