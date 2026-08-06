/// <reference lib="dom" />

import { PitchDetector, type PitchDetectionResult } from "../pitchDetector";

export interface PcmFrame {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  timestampMs: number;
}

export type CaptureStatus = "idle" | "requesting" | "listening" | "suspended" | "error";

export interface StartCaptureOptions {
  sampleRate?: number;
  frameSize?: number;
  hopSize?: number;
  channelCount?: number;
  silenceRmsThreshold?: number;
  lowCutHz?: number;
  highCutHz?: number;
  confidenceThreshold?: number;
  smoothingWindowFrames?: number;
  expectedNoteWindowSemitones?: number;
  deviceId?: string;
}

export interface LivePitchFrame {
  samples: Float32Array;
  timestampMs: number;
  sampleRate: number;
  frequencyHz: number | null;
  note: string | null;
  centsOff: number | null;
  confidence: number;
  rms: number;
  isSilent: boolean;
}

export interface CaptureErrorInfo {
  name: string;
  message: string;
  code: "permission_denied" | "microphone_unavailable" | "unsupported" | "audio_context_error" | "unknown";
}

export interface LiveCaptureState extends LivePitchFrame {
  status: CaptureStatus;
  frameSize: number;
  hopSize: number;
  error: CaptureErrorInfo | null;
}

export interface LiveCaptureCallbacks {
  onFrame?: (frame: LivePitchFrame) => void;
  onStateChange?: (state: LiveCaptureState) => void;
  onError?: (error: CaptureErrorInfo) => void;
}

export interface MicrophoneCaptureController {
  start(options?: StartCaptureOptions, callbacks?: LiveCaptureCallbacks): Promise<LiveCaptureState>;
  pause(): Promise<LiveCaptureState>;
  stop(): Promise<LiveCaptureState>;
  getState(): LiveCaptureState;
  subscribe(listener: (state: LiveCaptureState) => void): () => void;
}

export interface AudioCaptureModule {
  startCapture(options: StartCaptureOptions, onFrame: (frame: PcmFrame) => void): Promise<void>;
  stopCapture(): Promise<void>;
}

const DEFAULT_FRAME_SIZE = 2048;
const DEFAULT_HOP_SIZE = 512;
const DEFAULT_CHANNEL_COUNT = 1;
const DEFAULT_SILENCE_RMS_THRESHOLD = 0.02;
const DEFAULT_LOW_CUT_HZ = 180;
const DEFAULT_HIGH_CUT_HZ = 3500;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_SMOOTHING_WINDOW_FRAMES = 5;
const DEFAULT_EXPECTED_NOTE_WINDOW_SEMITONES = 3;
const WORKLET_NAME = "tunerapp-pcm-frame-processor";

type WorkletFrameMessage = {
  samples: Float32Array;
};

interface InternalCaptureCallbacks {
  onFrame?: (frame: LivePitchFrame) => void;
  onStateChange?: (state: LiveCaptureState) => void;
  onError?: (error: CaptureErrorInfo) => void;
}

interface CaptureConfig {
  frameSize: number;
  hopSize: number;
  channelCount: number;
  silenceRmsThreshold: number;
  lowCutHz: number;
  highCutHz: number;
  confidenceThreshold: number;
  smoothingWindowFrames: number;
  expectedNoteWindowSemitones: number;
  deviceId?: string;
}

function noteNameFromFrequency(frequencyHz: number): { note: string; centsOff: number } {
  const midi = Math.round(69 + 12 * Math.log2(frequencyHz / 440));
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const note = noteNames[(midi % 12 + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  const noteFrequencyHz = 440 * Math.pow(2, (midi - 69) / 12);
  return {
    note: `${note}${octave}`,
    centsOff: 1200 * Math.log2(frequencyHz / noteFrequencyHz)
  };
}

function createCaptureError(error: unknown): CaptureErrorInfo {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return { name: error.name, message: error.message || "Microphone access was denied.", code: "permission_denied" };
    }

    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return { name: error.name, message: error.message || "No usable microphone was found.", code: "microphone_unavailable" };
    }

    if (error.name === "InvalidStateError") {
      return { name: error.name, message: error.message || "The audio context could not be started.", code: "audio_context_error" };
    }

    return { name: error.name, message: error.message || "Audio capture failed.", code: "unknown" };
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: "unknown" };
  }

  return { name: "Error", message: "Audio capture failed.", code: "unknown" };
}

function isWorkletFrameMessage(value: unknown): value is WorkletFrameMessage {
  return typeof value === "object" && value !== null && value instanceof Object && "samples" in value;
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  const browserWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  return typeof AudioContext !== "undefined" ? AudioContext : browserWindow.webkitAudioContext ?? null;
}

function buildWorkletSource(): string {
  return `
    class FrameCollectorProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) {
          return true;
        }

        const channelCount = input.length;
        const frameLength = input[0].length;
        const mono = new Float32Array(frameLength);

        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          const channel = input[channelIndex];
          for (let sampleIndex = 0; sampleIndex < frameLength; sampleIndex += 1) {
            mono[sampleIndex] += channel[sampleIndex] / channelCount;
          }
        }

        this.port.postMessage({ samples: mono }, [mono.buffer]);
        return true;
      }
    }

    registerProcessor(${JSON.stringify(WORKLET_NAME)}, FrameCollectorProcessor);
  `;
}

function createDefaultState(config: CaptureConfig): LiveCaptureState {
  return {
    status: "idle",
    sampleRate: 0,
    samples: new Float32Array(0),
    timestampMs: 0,
    frequencyHz: null,
    note: null,
    centsOff: null,
    confidence: 0,
    rms: 0,
    isSilent: true,
    frameSize: config.frameSize,
    hopSize: config.hopSize,
    error: null
  };
}

class BrowserMicrophoneCaptureController implements MicrophoneCaptureController {
  private state: LiveCaptureState;
  private callbacks: InternalCaptureCallbacks = {};
  private config: CaptureConfig = {
    frameSize: DEFAULT_FRAME_SIZE,
    hopSize: DEFAULT_HOP_SIZE,
    channelCount: DEFAULT_CHANNEL_COUNT,
    silenceRmsThreshold: DEFAULT_SILENCE_RMS_THRESHOLD,
    lowCutHz: DEFAULT_LOW_CUT_HZ,
    highCutHz: DEFAULT_HIGH_CUT_HZ,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    smoothingWindowFrames: DEFAULT_SMOOTHING_WINDOW_FRAMES,
    expectedNoteWindowSemitones: DEFAULT_EXPECTED_NOTE_WINDOW_SEMITONES
  };

  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private mediaSource: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletModuleUrl: string | null = null;
  private detector: PitchDetector | null = null;
  private frameBuffer = new Float32Array(DEFAULT_FRAME_SIZE);
  private frameBufferLength = 0;
  private nextFrameStartSampleIndex = 0;
  private totalSamplesReceived = 0;
  private isStopping = false;
  private isPaused = false;
  private resumeListenersInstalled = false;
  private resumeListener: (() => void) | null = null;
  private beforeUnloadListener: (() => void) | null = null;
  private readonly stateListeners = new Set<(state: LiveCaptureState) => void>();

  constructor() {
    this.state = createDefaultState(this.config);
  }

  getState(): LiveCaptureState {
    return this.state;
  }

  subscribe(listener: (state: LiveCaptureState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  async start(options: StartCaptureOptions = {}, callbacks: LiveCaptureCallbacks = {}): Promise<LiveCaptureState> {
    this.callbacks = callbacks;

    if (this.audioContext && (this.state.status === "listening" || this.state.status === "suspended")) {
      this.isPaused = false;
      await this.ensureAudioContextRunning();
      this.emitState({ status: "listening", error: null });
      return this.state;
    }

    this.config = {
      frameSize: options.frameSize ?? DEFAULT_FRAME_SIZE,
      hopSize: options.hopSize ?? DEFAULT_HOP_SIZE,
      channelCount: options.channelCount ?? DEFAULT_CHANNEL_COUNT,
      silenceRmsThreshold: options.silenceRmsThreshold ?? DEFAULT_SILENCE_RMS_THRESHOLD,
      lowCutHz: options.lowCutHz ?? DEFAULT_LOW_CUT_HZ,
      highCutHz: options.highCutHz ?? DEFAULT_HIGH_CUT_HZ,
      confidenceThreshold: options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      smoothingWindowFrames: options.smoothingWindowFrames ?? DEFAULT_SMOOTHING_WINDOW_FRAMES,
      expectedNoteWindowSemitones: options.expectedNoteWindowSemitones ?? DEFAULT_EXPECTED_NOTE_WINDOW_SEMITONES,
      deviceId: options.deviceId
    };

    this.state = createDefaultState(this.config);
    this.frameBuffer = new Float32Array(Math.max(this.config.frameSize, this.config.frameSize * 2));
    this.frameBufferLength = 0;
    this.totalSamplesReceived = 0;
    this.nextFrameStartSampleIndex = 0;
    this.isPaused = false;
    this.isStopping = false;

    const audioContextConstructor = getAudioContextConstructor();
    if (!audioContextConstructor) {
      const error = createCaptureError(new Error("This browser does not support the Web Audio API."));
      this.emitState({ status: "error", error });
      callbacks.onError?.(error);
      throw error;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      const error = createCaptureError(new Error("Microphone capture requires a secure browser context."));
      this.emitState({ status: "error", error });
      callbacks.onError?.(error);
      throw error;
    }

    this.emitState({ status: "requesting", error: null });

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: this.config.channelCount,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(this.config.deviceId ? { deviceId: { exact: this.config.deviceId } } : {})
        }
      });

      const audioContext = new audioContextConstructor();
      this.audioContext = audioContext;
      this.mediaStream = mediaStream;
      this.detector = new PitchDetector({
        preprocess: {
          sampleRate: audioContext.sampleRate,
          silenceRmsThreshold: this.config.silenceRmsThreshold,
          lowCutHz: this.config.lowCutHz,
          highCutHz: this.config.highCutHz
        },
        confidenceThreshold: this.config.confidenceThreshold,
        smoothingWindowFrames: this.config.smoothingWindowFrames,
        expectedNoteWindowSemitones: this.config.expectedNoteWindowSemitones
      });

      this.mediaSource = audioContext.createMediaStreamSource(mediaStream);
      this.workletModuleUrl = this.installWorkletModule();
      await audioContext.audioWorklet.addModule(this.workletModuleUrl);

      this.workletNode = new AudioWorkletNode(audioContext, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });

      this.gainNode = audioContext.createGain();
      this.gainNode.gain.value = 0;

      this.workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!isWorkletFrameMessage(event.data)) {
          return;
        }

        this.handlePcmChunk(event.data.samples, audioContext.sampleRate);
      };

      this.mediaSource.connect(this.workletNode);
      this.workletNode.connect(this.gainNode);
      this.gainNode.connect(audioContext.destination);

      this.installResumeListeners();
      await this.ensureAudioContextRunning();

      this.emitState({
        status: audioContext.state === "suspended" ? "suspended" : "listening",
        sampleRate: audioContext.sampleRate,
        error: null
      });

      return this.state;
    } catch (error) {
      const normalizedError = createCaptureError(error);
      await this.dispose(true);
      this.emitState({ status: "error", error: normalizedError });
      callbacks.onError?.(normalizedError);
      throw normalizedError;
    }
  }

  async pause(): Promise<LiveCaptureState> {
    if (!this.audioContext || this.state.status === "idle") {
      return this.state;
    }

    this.isPaused = true;
    await this.audioContext.suspend();
    this.emitState({ status: "suspended" });
    return this.state;
  }

  async stop(): Promise<LiveCaptureState> {
    await this.dispose(true);
    this.state = createDefaultState(this.config);
    this.emitState({ status: "idle", error: null });
    return this.state;
  }

  private installWorkletModule(): string {
    const source = buildWorkletSource();
    const blob = new Blob([source], { type: "application/javascript" });
    return URL.createObjectURL(blob);
  }

  private installResumeListeners(): void {
    if (this.resumeListenersInstalled || typeof window === "undefined") {
      return;
    }

    this.resumeListener = () => {
      void this.ensureAudioContextRunning();
    };

    this.beforeUnloadListener = () => {
      void this.dispose(true);
    };

    window.addEventListener("pointerdown", this.resumeListener, { passive: true });
    window.addEventListener("keydown", this.resumeListener, { passive: true });
    window.addEventListener("touchstart", this.resumeListener, { passive: true });
    this.resumeListenersInstalled = true;
    window.addEventListener("beforeunload", this.beforeUnloadListener);
  }

  private async ensureAudioContextRunning(): Promise<void> {
    if (!this.audioContext || this.isStopping || this.isPaused) {
      return;
    }

    if (this.audioContext.state === "running") {
      return;
    }

    try {
      await this.audioContext.resume();
      if (!this.isPaused && !this.isStopping) {
        this.emitState({ status: "listening" });
      }
    } catch (error) {
      const normalizedError = createCaptureError(error);
      this.emitState({ status: "error", error: normalizedError });
      this.callbacks.onError?.(normalizedError);
    }
  }

  private handlePcmChunk(chunk: Float32Array, sampleRate: number): void {
    if (!this.detector || this.isStopping || this.state.status === "error") {
      return;
    }

    this.ensureFrameBufferCapacity(this.frameBufferLength + chunk.length);
    this.frameBuffer.set(chunk, this.frameBufferLength);
    this.frameBufferLength += chunk.length;
    this.totalSamplesReceived += chunk.length;

    while (this.frameBufferLength >= this.config.frameSize) {
      const frame = this.frameBuffer.subarray(0, this.config.frameSize);
      const samples = frame.slice();
      const timestampMs = (this.nextFrameStartSampleIndex / sampleRate) * 1000;
      const detection = this.detector.detect({ samples });
      const liveFrame = this.toLiveFrame(detection, sampleRate, timestampMs, samples);

      this.emitState({
        status: this.audioContext?.state === "suspended" ? "suspended" : "listening",
        sampleRate,
        timestampMs: liveFrame.timestampMs,
        frequencyHz: liveFrame.frequencyHz,
        note: liveFrame.note,
        centsOff: liveFrame.centsOff,
        confidence: liveFrame.confidence,
        rms: liveFrame.rms,
        isSilent: liveFrame.isSilent,
        error: null
      });

      this.callbacks.onFrame?.(liveFrame);

      if (this.frameBufferLength === this.config.frameSize) {
        this.frameBufferLength = 0;
      } else {
        this.frameBuffer.copyWithin(0, this.config.hopSize, this.frameBufferLength);
        this.frameBufferLength -= this.config.hopSize;
      }

      this.nextFrameStartSampleIndex += this.config.hopSize;
    }
  }

  private ensureFrameBufferCapacity(requiredCapacity: number): void {
    if (this.frameBuffer.length >= requiredCapacity) {
      return;
    }

    let nextCapacity = this.frameBuffer.length;
    while (nextCapacity < requiredCapacity) {
      nextCapacity *= 2;
    }

    const nextBuffer = new Float32Array(nextCapacity);
    nextBuffer.set(this.frameBuffer.subarray(0, this.frameBufferLength));
    this.frameBuffer = nextBuffer;
  }

  private toLiveFrame(
    detection: PitchDetectionResult,
    sampleRate: number,
    timestampMs: number,
    samples: Float32Array
  ): LivePitchFrame {
    const isSilent = detection.reason === "silence" || detection.rms < this.config.silenceRmsThreshold;

    if (!detection.frequencyHz || detection.frequencyHz <= 0) {
      return {
        samples,
        timestampMs,
        sampleRate,
        frequencyHz: null,
        note: null,
        centsOff: null,
        confidence: detection.confidence,
        rms: detection.rms,
        isSilent
      };
    }

    const noteInfo = noteNameFromFrequency(detection.frequencyHz);
    return {
      samples,
      timestampMs,
      sampleRate,
      frequencyHz: detection.frequencyHz,
      note: noteInfo.note,
      centsOff: noteInfo.centsOff,
      confidence: detection.confidence,
      rms: detection.rms,
      isSilent
    };
  }

  private emitState(patch: Partial<LiveCaptureState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
    this.callbacks.onStateChange?.(this.state);
  }

  private async dispose(releaseHardware: boolean): Promise<void> {
    this.isStopping = true;

    if (typeof window !== "undefined" && this.resumeListener) {
      window.removeEventListener("pointerdown", this.resumeListener);
      window.removeEventListener("keydown", this.resumeListener);
      window.removeEventListener("touchstart", this.resumeListener);
    }

    if (typeof window !== "undefined" && this.beforeUnloadListener) {
      window.removeEventListener("beforeunload", this.beforeUnloadListener);
    }

    this.resumeListener = null;
    this.beforeUnloadListener = null;
    this.resumeListenersInstalled = false;

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.mediaSource) {
      this.mediaSource.disconnect();
      this.mediaSource = null;
    }

    if (releaseHardware && this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (releaseHardware && this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Ignore close errors during teardown.
      }
      this.audioContext = null;
    }

    if (this.workletModuleUrl) {
      URL.revokeObjectURL(this.workletModuleUrl);
      this.workletModuleUrl = null;
    }

    this.detector = null;
    this.frameBufferLength = 0;
    this.totalSamplesReceived = 0;
    this.nextFrameStartSampleIndex = 0;
    this.isStopping = false;
  }
}

const defaultController = new BrowserMicrophoneCaptureController();

export function createMicrophoneCaptureController(): MicrophoneCaptureController {
  return new BrowserMicrophoneCaptureController();
}

export const captureModule: AudioCaptureModule = {
  async startCapture(options: StartCaptureOptions, onFrame: (frame: PcmFrame) => void): Promise<void> {
    await defaultController.start(options, {
      onFrame: (frame) => {
        onFrame({
          samples: frame.samples,
          sampleRate: frame.sampleRate,
          channels: 1,
          timestampMs: frame.timestampMs
        });
      }
    });
  },
  async stopCapture(): Promise<void> {
    await defaultController.stop();
  }
};

export const microphoneCaptureController = defaultController;