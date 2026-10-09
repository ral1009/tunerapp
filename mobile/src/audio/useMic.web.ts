import { useCallback, useEffect, useRef, useState } from 'react';

import type { MicChunk, MicHandle, MicStatus } from './micTypes';

// Web build: the browser's microphone through an AudioWorklet that posts raw 128-sample render
// quanta, batched to ~2048 samples. Same constraints as the web app's capture module: echo
// cancellation, noise suppression and auto gain off, or the browser reshapes the violin's sound.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tunerapp-tap', Tap);
`;

export function useMic(onChunk: (chunk: MicChunk) => void): MicHandle {
  const [status, setStatus] = useState<MicStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const onChunkRef = useRef(onChunk);
  useEffect(() => {
    onChunkRef.current = onChunk;
  }, [onChunk]);
  const nodes = useRef<{ context: AudioContext; media: MediaStream } | null>(null);

  const stop = useCallback(() => {
    const current = nodes.current;
    nodes.current = null;
    if (current) {
      current.media.getTracks().forEach((track) => track.stop());
      void current.context.close();
    }
    setStatus('idle');
  }, []);

  const start = useCallback(async () => {
    if (nodes.current) return;
    setError(null);
    setStatus('requesting');
    // Browsers only offer the microphone on secure pages: https, or localhost. Opened by LAN
    // address over plain http, navigator.mediaDevices is missing entirely.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('The browser only allows the microphone on a secure page — open the app at localhost, or use the phone app.');
      setStatus('error');
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const context = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const source = context.createMediaStreamSource(media);
      const tap = new AudioWorkletNode(context, 'tunerapp-tap');
      tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
        onChunkRef.current({ samples: event.data, sampleRate: context.sampleRate });
      };
      source.connect(tap);
      nodes.current = { context, media };
      setStatus('running');
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError') {
        setStatus('denied');
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    }
  }, []);

  useEffect(() => stop, [stop]);

  return { status, error, start, stop };
}
