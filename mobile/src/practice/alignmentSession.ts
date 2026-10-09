import * as Crypto from 'expo-crypto';

import type { AlignmentPoint } from '@core/practice/offlineIntonationScorer';

import { serverUrl } from '@/config/server';

// One take against the alignment server's /ws/align -- the app's counterpart to the web app's
// audio/matchmakerStream.ts, speaking the same protocol: config (hash + score) -> "ready" with the
// hop length -> raw float32 chunks of exactly that many samples -> positions in quarter notes ->
// on "stop", "completed" then the post-take alignment path, then close.
//
// Same rules as the web stream, for the same reasons (CLAUDE.md, Matchmaker section):
// - silence is never sent: a level gate with a 400 ms hold, against the room's noise floor
//   measured over the first half second (the capture module's calibration formula);
// - exactly the chunks sent are kept, so the post-take scorer and the server share a timeline;
// - "Jump to bar" goes over the same socket, so the server knows the sample it happened at.

export type SessionStatus = 'connecting' | 'preparing' | 'waiting' | 'streaming' | 'paused' | 'finishing' | 'completed' | 'error';

export interface SessionCallbacks {
  onStatus: (status: SessionStatus) => void;
  onPosition: (quarter: number) => void;
  onOfflinePath: (path: AlignmentPoint[]) => void;
  onClosed: () => void;
  onError: (message: string) => void;
}

const GATE_HOLD_MS = 400;
const CALIBRATION_MS = 500;
const CALIBRATION_GATE_RATIO = 1.5;
const CALIBRATION_GATE_FLOOR_RMS = 0.00002;
const CALIBRATION_GAIN_TARGET_RMS = 0.05;
const CALIBRATION_GAIN_EPSILON_RMS = 0.0005;
const MAX_GAIN_SCALAR = 32;

// The server only uses the hash as a cache key for its prepared reference. expo-crypto's web build
// needs crypto.subtle, which a plain-http page (the web build opened by LAN address) doesn't have,
// so fall back to a simple string hash there rather than never connecting.
async function hashScore(text: string): Promise<string> {
  try {
    return await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
  } catch {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b + c, 0x85ebca6b) >>> 0;
    }
    return `fnv-${a.toString(16)}${b.toString(16)}-${text.length}`;
  }
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export class AlignmentSession {
  private socket: WebSocket | null = null;
  private hop = 0;
  private sampleRate = 0;
  private pending = new Float32Array(0);
  private recorded: Float32Array[] = [];
  private calibration: number[] = [];
  private calibrationSamples = 0;
  private threshold = Number.POSITIVE_INFINITY;
  private noiseFloor = 0;
  private lastLoudMs = Number.NEGATIVE_INFINITY;
  private elapsedMs = 0;
  private gateOpen = false;
  private status: SessionStatus = 'connecting';
  private stopped = false;
  chunksSent = 0;

  // A later take in the same sitting (the next spot-practice pass) reuses the room's noise floor:
  // re-measuring it while the player is already playing set the gate at playing volume, and the
  // second pass never started.
  constructor(private readonly callbacks: SessionCallbacks, knownNoiseFloor?: number) {
    if (knownNoiseFloor !== undefined) {
      this.noiseFloor = knownNoiseFloor;
      this.threshold = Math.max(CALIBRATION_GATE_FLOOR_RMS, knownNoiseFloor * CALIBRATION_GATE_RATIO);
      this.calibrationSamples = Number.POSITIVE_INFINITY;
    }
  }

  get noiseFloorRms(): number | undefined {
    return Number.isFinite(this.threshold) ? this.noiseFloor : undefined;
  }

  private setStatus(status: SessionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.callbacks.onStatus(status);
  }

  // Opens the socket and waits for the server to prepare the score (seconds the first time).
  async connect(scoreXml: string, sampleRate: number): Promise<{ hopLength: number; totalQuarters: number }> {
    this.sampleRate = sampleRate;
    const scoreHash = await hashScore(scoreXml);
    const socket = new WebSocket(`${serverUrl().replace(/^http/, 'ws')}/ws/align`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setStatus('connecting');

    const ready = await new Promise<{ hopLength: number; totalQuarters: number }>((resolve, reject) => {
      const config = () => socket.send(JSON.stringify({ type: 'config', scoreHash, scoreXml, sampleRate }));
      socket.onopen = () => {
        this.setStatus('preparing');
        config();
      };
      socket.onerror = () => reject(new Error(`Couldn't reach the alignment server at ${serverUrl()}.`));
      socket.onclose = () => reject(new Error('The alignment server closed the connection.'));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.status === 'need_score') config();
        else if (message.status === 'ready') resolve(message);
        else if (message.status === 'error') reject(new Error(message.message ?? 'The alignment server reported an error.'));
      };
    });
    if (this.stopped) {
      socket.close();
      return ready;
    }
    this.hop = ready.hopLength;
    socket.onmessage = (event) => this.handleMessage(String(event.data));
    socket.onerror = () => this.fail('The alignment connection failed.');
    socket.onclose = () => {
      if (this.stopped) return;
      this.socket = null;
      this.callbacks.onClosed();
    };
    this.setStatus('waiting');
    return ready;
  }

  // Microphone audio in, any chunk size: re-cut into exact hop-sized chunks, gated, sent.
  push(samples: Float32Array): void {
    if (!this.socket || this.hop === 0 || this.stopped || this.status === 'finishing') return;
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= this.hop) {
      this.sendChunk(merged.slice(offset, offset + this.hop));
      offset += this.hop;
    }
    this.pending = merged.slice(offset);
  }

  private sendChunk(chunk: Float32Array): void {
    const level = rms(chunk);
    const chunkMs = (this.hop / this.sampleRate) * 1000;
    this.elapsedMs += chunkMs;
    if (this.calibrationSamples < (CALIBRATION_MS / 1000) * this.sampleRate) {
      this.calibration.push(level);
      this.calibrationSamples += chunk.length;
      const sorted = [...this.calibration].sort((a, b) => a - b);
      this.noiseFloor = sorted[Math.floor(sorted.length / 2)];
      this.threshold = Math.max(CALIBRATION_GATE_FLOOR_RMS, this.noiseFloor * CALIBRATION_GATE_RATIO);
      return;
    }
    if (level >= this.threshold) this.lastLoudMs = this.elapsedMs;
    const open = this.elapsedMs - this.lastLoudMs <= GATE_HOLD_MS;
    if (open !== this.gateOpen) {
      this.gateOpen = open;
      this.setStatus(open ? 'streaming' : this.chunksSent > 0 ? 'paused' : 'waiting');
    }
    if (!open || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(chunk.buffer as ArrayBuffer);
    this.recorded.push(chunk);
    this.chunksSent += 1;
  }

  seek(quarter: number): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: 'seek', quarter }));
    return true;
  }

  // End of the take: stop sending, keep the socket for the post-take alignment.
  finish(): void {
    this.setStatus('finishing');
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
  }

  // Abandon the take: nothing more is delivered.
  stop(): void {
    this.stopped = true;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
    this.socket?.close();
    this.socket = null;
  }

  recordedAudio(): Float32Array {
    const total = this.recorded.reduce((n, c) => n + c.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.recorded) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    return audio;
  }

  // The calibrated level setup the post-take scorer needs (same formula as the capture module).
  levels(): { silenceRmsThreshold: number; gainScalar: number } {
    const gainScalar = Math.max(1, Math.min(MAX_GAIN_SCALAR, CALIBRATION_GAIN_TARGET_RMS / Math.max(CALIBRATION_GAIN_EPSILON_RMS, this.noiseFloor)));
    return { silenceRmsThreshold: Number.isFinite(this.threshold) ? this.threshold : 0.005, gainScalar };
  }

  get rate(): number {
    return this.sampleRate;
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw);
    if (message.type === 'offlineAlignment' && Array.isArray(message.path)) {
      this.callbacks.onOfflinePath(message.path.map(([perfTimeSeconds, quarter]: [number, number]) => ({ perfTimeSeconds, quarter })));
      return;
    }
    if (typeof message.quarter === 'number') {
      this.callbacks.onPosition(message.quarter);
      return;
    }
    if (message.status === 'completed') {
      this.setStatus('completed');
      return;
    }
    if (message.status === 'error') this.fail(message.message ?? 'The alignment server reported an error.');
  }

  private fail(message: string): void {
    this.setStatus('error');
    this.callbacks.onError(message);
  }
}
