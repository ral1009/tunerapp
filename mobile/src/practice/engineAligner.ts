import type { EngineCommand, EngineEvent } from '@core/score/engine/protocol';

import { LOCAL_TAKE, type AlignmentTransport, type TransportEvents } from './alignmentSession';
import { probeEngine } from './perfProbe';

// Score following on this device: the transport that hands the take to the score engine's page
// (score/engine, practice/onDevice), which runs the same alignment as the laptop server -- a port
// checked against it frame by frame. The page has a JIT and its own thread; the app's JavaScript
// (Hermes, no JIT) only cuts the audio into chunks and encodes them.
//
// Audio goes as float32 (exactly the samples, as the server received them), base64, two hops
// (~67 ms) per message: few enough messages for the bridge, small enough not to delay the cursor.

const CHUNKS_PER_MESSAGE = 2;
const PREPARE_TIMEOUT_MS = 30000;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = Uint8Array.from(B64, (c) => c.charCodeAt(0));
const EQUALS = 61;

// Float32 little-endian as base64, built as character codes and turned into a string in slices:
// per-character string concatenation is what's slow without a JIT.
function f32Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out[o] = B64_CODES[a >> 2];
    out[o + 1] = B64_CODES[((a & 3) << 4) | (b >> 4)];
    out[o + 2] = i + 1 < bytes.length ? B64_CODES[((b & 15) << 2) | (c >> 6)] : EQUALS;
    out[o + 3] = i + 2 < bytes.length ? B64_CODES[c & 63] : EQUALS;
    o += 4;
  }
  const parts: string[] = [];
  for (let i = 0; i < out.length; i += 8192) parts.push(String.fromCharCode.apply(null, out.subarray(i, i + 8192) as unknown as number[]));
  return parts.join('');
}

interface Live {
  id: string;
  events: TransportEvents;
  ready: ((value: { hopLength: number; totalQuarters: number }) => void) | null;
  fail: ((error: Error) => void) | null;
  queued: Float32Array[];
  finished: boolean;
  sent: number; // hop chunks handed to the engine
}

// Created once per practice screen; attach() connects it to the score view once that exists, and
// every engine event goes through handle().
export function createEngineAligner() {
  let send: (command: EngineCommand) => void = () => undefined;
  let live: Live | null = null;
  let counter = 0;

  const flush = (session: Live) => {
    if (!session.queued.length) return;
    const total = session.queued.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let offset = 0;
    for (const c of session.queued) {
      joined.set(c, offset);
      offset += c.length;
    }
    session.queued = [];
    send({ type: 'alignAudio', id: session.id, f32: f32Base64(joined) });
  };

  const transport = (): AlignmentTransport => {
    let session: Live | null = null;
    return {
      open(_scoreXml, sampleRate, events, onPreparing) {
        counter += 1;
        const id = `align-${Date.now().toString(36)}-${counter}`;
        onPreparing();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (session?.ready) reject(new Error('Preparing the score took too long. Try again.'));
          }, PREPARE_TIMEOUT_MS);
          session = {
            id,
            events,
            ready: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            fail: (error) => {
              clearTimeout(timer);
              reject(error);
            },
            queued: [],
            finished: false,
            sent: 0,
          };
          live = session;
          // The engine builds the reference from the score it has loaded (the same XML).
          send({ type: 'alignStart', id, sampleRate });
        });
      },
      send(chunk) {
        if (!session || session.finished || live !== session) return false;
        session.queued.push(chunk);
        session.sent += 1;
        if (session.queued.length >= CHUNKS_PER_MESSAGE) flush(session);
        return true;
      },
      seek(quarter) {
        if (!session || session.finished || live !== session) return false;
        flush(session); // the jump happens after the audio already sent
        send({ type: 'alignSeek', id: session.id, quarter });
        return true;
      },
      finish() {
        if (!session || session.finished) return;
        flush(session);
        session.finished = true;
        send({ type: 'alignFinish', id: session.id });
      },
      close() {
        if (!session) return;
        send({ type: 'alignStop', id: session.id });
        if (live === session) live = null;
        session = null;
      },
    };
  };

  // Feed every engine event through this; returns true if it was an alignment event.
  const handle = (event: EngineEvent): boolean => {
    if (!('id' in event) || !String(event.id).startsWith('align-')) return false;
    const session = live;
    if (!session || session.id !== event.id) return true;
    switch (event.type) {
      case 'alignReady':
        session.ready?.({ hopLength: event.hopLength, totalQuarters: event.totalQuarters });
        session.ready = null;
        session.fail = null;
        break;
      case 'alignPosition':
        session.events.onPosition(event.quarter);
        break;
      case 'alignStats':
        probeEngine(Math.max(0, session.sent - event.processed), event.busyMs, event.worstMs);
        break;
      case 'alignPath':
        session.finished = true;
        if (event.completed) session.events.onCompleted();
        session.events.onPath(
          event.path.map(([perfTimeSeconds, quarter]) => ({ perfTimeSeconds, quarter })),
          LOCAL_TAKE,
        );
        live = null;
        break;
      case 'alignFailed':
        if (session.fail) session.fail(new Error(event.message));
        else session.events.onError(`Score following failed: ${event.message}`);
        session.ready = null;
        session.fail = null;
        break;
      default:
        break;
    }
    return true;
  };

  const attach = (to: (command: EngineCommand) => void) => {
    send = to;
  };

  return { transport, handle, attach };
}
