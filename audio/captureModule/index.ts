export interface PcmFrame {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  timestampMs: number;
}

export interface StartCaptureOptions {
  sampleRate?: number;
  frameSize?: number;
  channelCount?: number;
}

export interface AudioCaptureModule {
  startCapture(options: StartCaptureOptions, onFrame: (frame: PcmFrame) => void): Promise<void>;
  stopCapture(): Promise<void>;
}

// Placeholder interface for the future native bridge implementation.
export const captureModule: AudioCaptureModule = {
  async startCapture(): Promise<void> {
    throw new Error("Native capture module is not yet wired. Implement iOS/Android bridge in Phase 0 native step.");
  },
  async stopCapture(): Promise<void> {
    throw new Error("Native capture module is not yet wired. Implement iOS/Android bridge in Phase 0 native step.");
  }
};