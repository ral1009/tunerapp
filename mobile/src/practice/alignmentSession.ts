import * as Crypto from 'expo-crypto';

import type { AlignmentPoint } from '@core/practice/offlineIntonationScorer';

import { serverUrl } from '@/config/server';

// One take of score following. The session decides which audio is sent and keeps it; a transport
// does the following -- either on this device, in the score engine (engineAligner.ts, the default),
// or on the laptop server over /ws/align (ServerTransport below, the web app's
// audio/matchmakerStream.ts protocol). Both give the same positions and post-take path: the
// device's alignment is a port of the server's, checked against it (`npm run deviceAlignTest`).
//
// Same rules either way, for the same reasons (CLAUDE.md, Matchmaker section):
// - silence is never sent: a level gate with a 400 ms hold, against the room's noise floor
//   measured over the first half second (the capture module's calibration formula);
// - exactly the chunks sent are kept, so the post-take scorer and the follower share a timeline;
// - "Jump to bar" goes the same way as the audio, so the follower knows the sample it happened at.

export type SessionStatus = 'connecting' | 'preparing' | 'waiting' | 'streaming' | 'paused' | 'finishing' | 'completed' | 'error';

export interface SessionCallbacks {
  onStatus: (status: SessionStatus) => void;
  onPosition: (quarter: number) => void;
  // takeId: where the post-take grader finds the take's audio -- the server's copy
  // (GET /api/take/<id>), LOCAL_TAKE for the take the score engine aligned, null for neither.
  onOfflinePath: (path: AlignmentPoint[], takeId: string | null) => void;
  onClosed: () => void;
  onError: (message: string) => void;
}

// takeId meaning "the score engine holds this take" (see engineAligner.ts).
export const LOCAL_TAKE = 'local';

export interface TransportEvents {
  onPosition: (quarter: number) => void;
  onCompleted: () => void;
  onPath: (path: AlignmentPoint[], takeId: string | null) => void;
  onLost: () => void; // ended by something other than us
  onError: (message: string) => void;
}

export interface AlignmentTransport {
  // Prepares the score and reports the hop length to cut audio into.
  open(scoreXml: string, sampleRate: number, events: TransportEvents, onPreparing: () => void): Promise<{ hopLength: number; totalQuarters: number }>;
  send(chunk: Float32Array): boolean;
  seek(quarter: number): boolean;
  finish(): void; // stop taking audio, deliver the post-take path
  close(): void; // abandon: nothing more is delivered
}

const GATE_HOLD_MS = 400;
const CALIBRATION_MS = 500;
const CALIBRATION_GATE_RATIO = 1.5;
const CALIBRATION_GATE_FLOOR_RMS = 0.00002;
const CALIBRATION_GAIN_TARGET_RMS = 0.05;
const CALIBRATION_GAIN_EPSILON_RMS = 0.0005;
const MAX_GAIN_SCALAR = 32;

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export class AlignmentSession {
  private hop = 0;
  private sampleRate = 0;
  // The chunk being filled: exactly one hop long, sent and replaced each time it fills.
  private pending = new Float32Array(0);
  private pendingFill = 0;
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
  private open = false;
  chunksSent = 0;

  // A later take in the same sitting (the next spot-practice pass) reuses the room's noise floor:
  // re-measuring it while the player is already playing set the gate at playing volume, and the
  // second pass never started.
  constructor(
    private readonly callbacks: SessionCallbacks,
    private readonly transport: AlignmentTransport,
    knownNoiseFloor?: number,
  ) {
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

  async connect(scoreXml: string, sampleRate: number): Promise<{ hopLength: number; totalQuarters: number }> {
    this.sampleRate = sampleRate;
    this.setStatus('connecting');
    const ready = await this.transport.open(
      scoreXml,
      sampleRate,
      {
        onPosition: (quarter) => !this.stopped && this.callbacks.onPosition(quarter),
        onCompleted: () => this.setStatus('completed'),
        onPath: (path, takeId) => !this.stopped && this.callbacks.onOfflinePath(path, takeId),
        onLost: () => {
          if (this.stopped) return;
          this.open = false;
          // Dropped mid-take (Wi-Fi blip, server restart) rather than ended by us: say so.
          if (this.status !== 'finishing' && this.status !== 'completed') this.fail('Lost the connection to the server. Your take so far couldn’t be graded — tap Try again.');
          this.callbacks.onClosed();
        },
        onError: (message) => this.fail(message),
      },
      () => this.setStatus('preparing'),
    );
    if (this.stopped) {
      this.transport.close();
      return ready;
    }
    this.hop = ready.hopLength;
    this.open = true;
    this.setStatus('waiting');
    return ready;
  }

  // Microphone audio in, any chunk size: re-cut into exact hop-sized chunks, gated, sent.
  push(samples: Float32Array): void {
    if (!this.open || this.hop === 0 || this.stopped || this.status === 'finishing') return;
    // Fill fixed hop-sized chunks in place; no merged copy of everything per callback.
    if (this.pending.length !== this.hop) {
      this.pending = new Float32Array(this.hop);
      this.pendingFill = 0;
    }
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.hop - this.pendingFill, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + take), this.pendingFill);
      this.pendingFill += take;
      offset += take;
      if (this.pendingFill === this.hop) {
        const chunk = this.pending;
        this.pending = new Float32Array(this.hop);
        this.pendingFill = 0;
        this.sendChunk(chunk);
      }
    }
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
    if (!open || !this.transport.send(chunk)) return;
    this.recorded.push(chunk);
    this.chunksSent += 1;
  }

  seek(quarter: number): boolean {
    return this.open && this.transport.seek(quarter);
  }

  // End of the take: stop sending, wait for the post-take alignment.
  finish(): void {
    this.setStatus('finishing');
    this.transport.finish();
  }

  // Abandon the take: nothing more is delivered.
  stop(): void {
    this.stopped = true;
    this.open = false;
    this.transport.close();
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

  private fail(message: string): void {
    this.setStatus('error');
    this.callbacks.onError(message);
  }
}

// ---- the laptop server (/ws/align) ---------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 6000;
const READY_TIMEOUT_MS = 30000;

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

export class ServerTransport implements AlignmentTransport {
  private socket: WebSocket | null = null;
  private closedByUs = false;

  async open(scoreXml: string, sampleRate: number, events: TransportEvents, onPreparing: () => void): Promise<{ hopLength: number; totalQuarters: number }> {
    const scoreHash = await hashScore(scoreXml);
    const socket = new WebSocket(`${serverUrl().replace(/^http/, 'ws')}/ws/align`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    const host = serverUrl().replace(/^https?:\/\//, '');
    const ready = await new Promise<{ hopLength: number; totalQuarters: number }>((resolve, reject) => {
      // Never wait forever: a socket that doesn't open, or a server that never says ready, is a
      // clear error after a few seconds rather than "Connecting…" for good.
      const openTimer = setTimeout(() => {
        reject(new Error(`Couldn't reach the server at ${host}. Is it running with --host 0.0.0.0, and is this device on the same Wi-Fi?`));
        socket.close();
      }, CONNECT_TIMEOUT_MS);
      let readyTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        clearTimeout(openTimer);
        if (readyTimer) clearTimeout(readyTimer);
      };
      const config = () => socket.send(JSON.stringify({ type: 'config', scoreHash, scoreXml, sampleRate }));
      socket.onopen = () => {
        clearTimeout(openTimer);
        readyTimer = setTimeout(() => {
          reject(new Error('The server took too long to prepare the score. Try again; if it keeps happening, restart the server.'));
          socket.close();
        }, READY_TIMEOUT_MS);
        onPreparing();
        config();
      };
      socket.onerror = () => {
        done();
        reject(new Error(`Couldn't reach the server at ${host}. Is it running with --host 0.0.0.0, and is this device on the same Wi-Fi?`));
      };
      socket.onclose = () => {
        done();
        reject(new Error('The server closed the connection before practice could start.'));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.status === 'need_score') config();
        else if (message.status === 'ready') {
          done();
          resolve(message);
        } else if (message.status === 'error') {
          done();
          reject(new Error(message.message ?? 'The alignment server reported an error.'));
        }
      };
    });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'offlineAlignment' && Array.isArray(message.path)) {
        events.onPath(
          message.path.map(([perfTimeSeconds, quarter]: [number, number]) => ({ perfTimeSeconds, quarter })),
          typeof message.takeId === 'string' ? message.takeId : null,
        );
      } else if (typeof message.quarter === 'number') events.onPosition(message.quarter);
      else if (message.status === 'completed') events.onCompleted();
      else if (message.status === 'error') events.onError(message.message ?? 'The alignment server reported an error.');
    };
    socket.onerror = () => events.onError('The alignment connection failed.');
    socket.onclose = () => {
      this.socket = null;
      if (!this.closedByUs) events.onLost();
    };
    return ready;
  }

  send(chunk: Float32Array): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(chunk.buffer as ArrayBuffer);
    return true;
  }

  seek(quarter: number): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: 'seek', quarter }));
    return true;
  }

  finish(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
  }

  close(): void {
    this.closedByUs = true;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
    this.socket?.close();
    this.socket = null;
  }
}
