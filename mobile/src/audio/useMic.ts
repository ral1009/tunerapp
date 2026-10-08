import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MicChunk, MicHandle, MicStatus } from './micTypes';

// iOS/Android: expo-audio's native stream delivers float32 PCM buffers as they're captured.
export function useMic(onChunk: (chunk: MicChunk) => void): MicHandle {
  const [status, setStatus] = useState<MicStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const onChunkRef = useRef(onChunk);
  useEffect(() => {
    onChunkRef.current = onChunk;
  }, [onChunk]);

  const { stream } = useAudioStream({
    sampleRate: 48000,
    channels: 1,
    encoding: 'float32',
    onBuffer: (buffer) => {
      // Copy out of the native buffer: consumers keep frames around between callbacks.
      onChunkRef.current({ samples: new Float32Array(buffer.data.slice(0)), sampleRate: buffer.sampleRate });
    },
  });

  const start = useCallback(async () => {
    setError(null);
    setStatus('requesting');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setStatus('denied');
        return;
      }
      // iOS records only with this set; playsInSilentMode keeps it working with the switch on mute.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await stream.start();
      setStatus('running');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [stream]);

  const stop = useCallback(() => {
    try {
      stream.stop();
    } catch {
      // Already stopped.
    }
    setStatus('idle');
  }, [stream]);

  return { status, error, start, stop };
}
