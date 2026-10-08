// One microphone interface for every platform: expo-audio's real-time PCM stream on iOS/Android
// (useMic.ts) and the browser's own microphone in the web build (useMic.web.ts), because expo-audio's
// stream is a stub on web and the web build is how the app gets tested on a laptop.

export type MicStatus = 'idle' | 'requesting' | 'running' | 'denied' | 'error';

export interface MicChunk {
  samples: Float32Array; // mono, -1..1
  sampleRate: number;
}

export interface MicHandle {
  status: MicStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}
