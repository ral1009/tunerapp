import { serverUrl } from '@/config/server';

// A flight recorder for practice takes on a real phone: every microphone sample (before any gate)
// and a timeline of what the session did -- gate open/closed, positions from the follower, the
// engine's counters, cursor moves. When the take ends it goes to the laptop server
// (POST /api/debug/device-take, saved under server/tmp/device-takes/) if the server answers, so a
// take where following stopped can be replayed offline exactly (.scratch/replay_device_take.ts).
// Added after "following randomly stops" on a phone, which replaying the recordings we had didn't
// reproduce. Costs one Int16 copy of the audio (~6 MB a minute) and nothing if the upload fails.

const MAX_SECONDS = 600;

interface Trace {
  startedAt: number;
  sampleRate: number;
  following: string;
  audio: Int16Array[];
  samples: number;
  events: [number, number, string, unknown][]; // ms since start, mic samples so far, kind, data
}

let trace: Trace | null = null;

export function startTrace(following: string): void {
  trace = { startedAt: Date.now(), sampleRate: 0, following, audio: [], samples: 0, events: [] };
}

export function traceEvent(kind: string, data?: unknown): void {
  if (!trace) return;
  trace.events.push([Date.now() - trace.startedAt, trace.samples, kind, data ?? null]);
}

export function traceAudio(samples: Float32Array, sampleRate: number): void {
  if (!trace || trace.samples > MAX_SECONDS * (sampleRate || 48000)) return;
  trace.sampleRate = sampleRate;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] * 32767;
    out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
  }
  trace.audio.push(out);
  trace.samples += out.length;
  // Where each mic buffer falls in time, so gaps in delivery show up.
  if (trace.audio.length % 10 === 1) traceEvent('mic');
}

// Sends the take and forgets it. Fire and forget: nothing waits on it.
export function uploadTrace(extra: Record<string, unknown>): void {
  const t = trace;
  trace = null;
  if (!t || t.samples === 0) return;
  try {
    const meta = new TextEncoder().encode(
      JSON.stringify({ ...extra, sampleRate: t.sampleRate, following: t.following, startedAt: t.startedAt, events: t.events }),
    );
    const body = new Uint8Array(4 + meta.length + t.samples * 2);
    new DataView(body.buffer).setUint32(0, meta.length, true);
    body.set(meta, 4);
    let offset = 4 + meta.length;
    for (const chunk of t.audio) {
      body.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
      offset += chunk.byteLength;
    }
    void fetch(`${serverUrl()}/api/debug/device-take`, { method: 'POST', body }).catch(() => undefined);
  } catch {
    // Diagnostics only.
  }
}
