// How the on-device score follower copes with practice as it really happens, not clean
// play-throughs: pauses, talking, restarting a phrase or the whole piece, skipping ahead, mic
// dropouts, starting partway in, playing much slower than the score's tempo.
//
// Each case is a real take from server/tmp/fixtures (see server/export_alignment_fixtures.py)
// spliced into a perturbed take. Ground truth comes from the clean take's server post-take path
// (time -> quarter): an inserted stretch has no truth (the follower should hold still), a splice
// maps each output sample back to its source time. Per run it reports:
//   track   share of the playing (outside a few seconds' grace after each event) where the live
//           position is within 1 s of reference time of the truth
//   recover seconds from each event until the live position is back within that and stays 1 s
//   drift   how far the live position moved during inserted non-music (qn)
//   end     whether the live position finished at the truth's last position
//   post    share of the playing where the post-take path is within 0.25 s of reference time
//
// Usage: npm run alignStressTest [-- --all] [-- case-filter]
//   --server runs the server's behaviour (no place finder, step 3) for comparison.
//   --all also runs the held-out takes (bwv1006-menuet1, user-take-b): only look at those once a
//   change is finished. The slow (70%) takes and the speech clips live in fixtures/_stress
//   (librosa time_stretch of each take's audio; Windows TTS) -- runs without them skip those cases.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { scoreNotes } from "../../score/scoreNotes";
import { buildReference, DeviceAligner, SERVER_BEHAVIOUR, type AlignmentReference, type DeviceAlignerOptions } from "../onDevice/deviceAligner";

const ROOT = "server/tmp/fixtures";
const STRESS = join(ROOT, "_stress");
const DEV = ["beginner-d-scale-flat-habit", "beginner-lightly-row-self-tuned", "beginner-twinkle-careful", "bwv1004-giga", "user-take-a", "bwv1006-menuet1", "user-take-b"];
const HELD_OUT = ["bwv1004-corrente", "bwv1004-allemanda-qmul", "bwv1004-allemanda-vicond"];
const TRACK_TOLERANCE_S = 1.0;
const POST_TOLERANCE_S = 0.25;
const GRACE_S = 3;
const TRACE = !!process.env.STRESS_TRACE;

type Segment = { kind: "src"; from: number; to: number; stretch?: number } | { kind: "insert"; samples: Float32Array };

interface Case {
  name: string;
  sr: number;
  tempo: number;
  audio: Float32Array;
  slow: Float32Array | null;
  truth: [number, number][]; // (seconds on the take, quarter)
  reference: AlignmentReference;
}

function f32(path: string): Float32Array {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function wav16(path: string, sr: number): Float32Array {
  const buf = readFileSync(path);
  let p = 12;
  let rate = 48000;
  while (p < buf.length - 8) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") rate = buf.readUInt32LE(p + 12);
    if (id === "data") {
      const n = size / 2;
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i += 1) raw[i] = buf.readInt16LE(p + 8 + 2 * i) / 32768;
      // Linear resample to the take's rate.
      const out = new Float32Array(Math.floor((n * sr) / rate));
      for (let i = 0; i < out.length; i += 1) {
        const x = (i * rate) / sr;
        const k = Math.floor(x);
        out[i] = raw[k] + (raw[Math.min(k + 1, n - 1)] - raw[k]) * (x - k);
      }
      return out;
    }
    p += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${path}`);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function noise(n: number, level: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (r() * 2 - 1) * level * 1.732;
  return out;
}

// A bumped violin: a knock, body modes, and the open strings ringing briefly (as .scratch/gate_features.py).
function bump(sr: number, seed: number, peak: number): Float32Array {
  const r = rng(seed);
  const n = Math.round(1.5 * sr);
  const y = new Float32Array(n);
  for (let i = 0; i < 240; i += 1) y[i] += (r() * 2 - 1) * Math.exp(-i / 40);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    for (const [f, d] of [[280, 0.05], [460, 0.04], [550, 0.03], [1000, 0.02]]) y[i] += 0.5 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / d);
  }
  for (const f0 of [196.0, 293.66, 440.0, 659.26]) {
    const a = 0.02 + r() * 0.13;
    for (let h = 1; h < 8; h += 1) {
      const ph = r() * 6;
      for (let i = 0; i < n; i += 1) y[i] += (a / h) * Math.sin(2 * Math.PI * f0 * h * (i / sr) + ph) * Math.exp(-(i / sr) * (1.5 + h));
    }
  }
  let m = 0;
  for (const v of y) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < n; i += 1) y[i] *= peak / (m + 1e-9);
  return y;
}

function playingRms(audio: Float32Array): number {
  let peak = 0;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  let sum = 0;
  let n = 0;
  for (const v of audio) {
    if (Math.abs(v) > 0.01 * peak) {
      sum += v * v;
      n += 1;
    }
  }
  return Math.sqrt(sum / Math.max(1, n));
}

function scaled(x: Float32Array, rms: number): Float32Array {
  let sum = 0;
  let n = 0;
  for (const v of x) {
    if (Math.abs(v) > 0.01) {
      sum += v * v;
      n += 1;
    }
  }
  const g = rms / (Math.sqrt(sum / Math.max(1, n)) + 1e-9);
  return x.map((v) => v * g);
}

function talking(sr: number, rms: number): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < 3; i += 1) {
    const path = join(STRESS, `speech${i}.wav`);
    if (!existsSync(path)) continue;
    parts.push(new Float32Array(Math.round(0.4 * sr)), scaled(wav16(path, sr).subarray(0, Math.round(4 * sr)), 0.5 * rms), new Float32Array(Math.round(0.3 * sr)), bump(sr, i, 2 * rms));
  }
  parts.push(new Float32Array(Math.round(0.4 * sr)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface Scenario {
  name: string;
  build: (c: Case) => { segments: Segment[]; source: Float32Array; stretch: number } | null;
}

const at = (c: Case, frac: number) => Math.round(frac * c.audio.length);
const sec = (c: Case, s: number) => Math.round(s * c.sr);

const SCENARIOS: Scenario[] = [
  { name: "clean", build: (c) => ({ source: c.audio, stretch: 1, segments: [{ kind: "src", from: 0, to: c.audio.length }] }) },
  {
    name: "pause 6s",
    build: (c) => ({ source: c.audio, stretch: 1, segments: [{ kind: "src", from: 0, to: at(c, 0.45) }, { kind: "insert", samples: noise(sec(c, 6), 0.0015, 1) }, { kind: "src", from: at(c, 0.45), to: c.audio.length }] }),
  },
  {
    name: "talk+bumps",
    build: (c) => ({ source: c.audio, stretch: 1, segments: [{ kind: "src", from: 0, to: at(c, 0.45) }, { kind: "insert", samples: talking(c.sr, playingRms(c.audio)) }, { kind: "src", from: at(c, 0.45), to: c.audio.length }] }),
  },
  {
    name: "hesitations 3x2s",
    build: (c) => {
      const cuts = [0.3, 0.55, 0.8].map((f) => at(c, f));
      const segments: Segment[] = [];
      let from = 0;
      cuts.forEach((cut, i) => {
        segments.push({ kind: "src", from, to: cut }, { kind: "insert", samples: noise(sec(c, 2), 0.0015, 10 + i) });
        from = cut;
      });
      segments.push({ kind: "src", from, to: c.audio.length });
      return { source: c.audio, stretch: 1, segments };
    },
  },
  {
    name: "back 5s",
    build: (c) => ({ source: c.audio, stretch: 1, segments: [{ kind: "src", from: 0, to: at(c, 0.55) }, { kind: "src", from: at(c, 0.55) - sec(c, 5), to: c.audio.length }] }),
  },
  {
    name: "restart from top",
    build: (c) => ({ source: c.audio, stretch: 1, segments: [{ kind: "src", from: 0, to: at(c, 0.5) }, { kind: "insert", samples: noise(sec(c, 1.5), 0.0015, 3) }, { kind: "src", from: 0, to: c.audio.length }] }),
  },
  {
    name: "skip 4s",
    build: (c) => ({ source: c.audio, stretch: 1, segments: [{ kind: "src", from: 0, to: at(c, 0.4) }, { kind: "src", from: at(c, 0.4) + sec(c, 4), to: c.audio.length }] }),
  },
  {
    name: "dropouts 8x250ms",
    build: (c) => {
      const r = rng(7);
      const starts = Array.from({ length: 8 }, () => Math.round((0.1 + 0.8 * r()) * c.audio.length)).sort((a, b) => a - b);
      const segments: Segment[] = [];
      let from = 0;
      for (const s of starts) {
        if (s <= from) continue;
        segments.push({ kind: "src", from, to: s });
        from = s + sec(c, 0.25);
      }
      segments.push({ kind: "src", from, to: c.audio.length });
      return { source: c.audio, stretch: 1, segments };
    },
  },
  { name: "start at 30%", build: (c) => ({ source: c.audio, stretch: 1, segments: [{ kind: "src", from: at(c, 0.3), to: c.audio.length }] }) },
  { name: "slow 70%", build: (c) => (c.slow ? { source: c.slow, stretch: 1 / 0.7, segments: [{ kind: "src", from: 0, to: c.slow.length }] } : null) },
];

function truthAt(truth: [number, number][], t: number): number {
  if (t <= truth[0][0]) return truth[0][1];
  let lo = 0;
  let hi = truth.length - 1;
  if (t >= truth[hi][0]) return truth[hi][1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (truth[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, q0] = truth[lo];
  const [t1, q1] = truth[hi];
  return q0 + ((q1 - q0) * (t - t0)) / Math.max(1e-9, t1 - t0);
}

interface RunResult {
  track: number;
  recover: number[];
  drift: number;
  end: boolean;
  post: number;
  msPerFrame: number;
  postMs: number;
  recoveries: number;
  errS: number[]; // |live - truth| in reference seconds, over the counted frames
}

function run(c: Case, scenario: Scenario, options: DeviceAlignerOptions): RunResult | null {
  const built = scenario.build(c);
  if (!built) return null;
  const { segments, source, stretch } = built;
  // The output audio and, per output sample, the source time (seconds on the clean take) or null.
  const total = segments.reduce((n, s) => n + (s.kind === "src" ? s.to - s.from : s.samples.length), 0);
  const audio = new Float32Array(total);
  const srcTime = new Float64Array(total).fill(NaN);
  const events: number[] = []; // output samples where something happened
  let o = 0;
  segments.forEach((s, i) => {
    // Something happened where playing resumes (after an insert, or at a splice).
    if (i > 0 && s.kind === "src") events.push(o);
    if (s.kind === "src") {
      audio.set(source.subarray(s.from, s.to), o);
      for (let k = 0; k < s.to - s.from; k += 1) srcTime[o + k] = ((s.from + k) / c.sr) / stretch;
      o += s.to - s.from;
    } else {
      audio.set(s.samples, o);
      o += s.samples.length;
    }
  });
  // A late start is an event at 0.
  if (segments[0].kind === "src" && segments[0].from > 0) events.unshift(0);

  const aligner = new DeviceAligner(c.reference, options);
  const hop = c.reference.hop;
  const message = 2 * hop;
  const live: { sample: number; q: number }[] = [];
  let q = c.reference.quarterOrigin;
  const t0 = performance.now();
  let frames = 0;
  for (let s = 0; s + message <= audio.length; s += message) {
    const moved = aligner.push(audio.subarray(s, s + message));
    frames += 2;
    if (moved !== null) q = moved;
    live.push({ sample: s + message, q });
    if (TRACE && Math.floor((s + message) / c.sr) !== Math.floor(s / c.sr)) {
      const t = srcTime[Math.min(s + message, total - 1)];
      console.log(`      ${((s + message) / c.sr).toFixed(0)}s live ${q.toFixed(2)} truth ${Number.isNaN(t) ? "-" : truthAt(c.truth, t).toFixed(2)} moves ${aligner.recoveries}`);
    }
    if (aligner.completed) break;
  }
  const msPerFrame = (performance.now() - t0) / Math.max(1, frames);
  const tp = performance.now();
  const path = aligner.finish();
  const postMs = performance.now() - tp;
  if (TRACE && aligner.postTakeChoice) console.log(`      post-take: with moves ${aligner.postTakeChoice.withMoves.toFixed(3)}, without ${aligner.postTakeChoice.without.toFixed(3)}`);

  const tolQ = (TRACK_TOLERANCE_S * c.tempo) / 60;
  const postTolQ = (POST_TOLERANCE_S * c.tempo) / 60;
  const graceUntil = (sample: number) => events.some((e) => sample >= e && sample < e + GRACE_S * c.sr);
  let good = 0;
  let counted = 0;
  const errS: number[] = [];
  let drift = 0;
  let insertStartQ: number | null = null;
  const errAt: number[] = live.map(() => NaN);
  live.forEach((p, i) => {
    const t = srcTime[Math.min(p.sample - 1, total - 1)];
    if (Number.isNaN(t)) {
      if (insertStartQ === null) insertStartQ = i > 0 ? live[i - 1].q : p.q;
      drift = Math.max(drift, Math.abs(p.q - insertStartQ));
      return;
    }
    insertStartQ = null;
    const err = Math.abs(p.q - truthAt(c.truth, t));
    errAt[i] = err;
    if (p.sample < 2 * c.sr || graceUntil(p.sample)) return;
    counted += 1;
    errS.push((err * 60) / c.tempo);
    if (err <= tolQ) good += 1;
  });
  // Recovery: from each event, the first time the error is within tolerance for a whole second.
  const lastLive = live[live.length - 1].sample;
  const recover = events.filter((e) => lastLive - e >= 4 * c.sr).map((e) => {
    const needed = Math.ceil(c.sr / message);
    let run = 0;
    for (let i = 0; i < live.length; i += 1) {
      if (live[i].sample < e) continue;
      if (Number.isNaN(errAt[i])) {
        run = 0;
        continue;
      }
      run = errAt[i] <= tolQ ? run + 1 : 0;
      if (run >= needed) return (live[i - needed + 1].sample - e) / c.sr;
    }
    return Infinity;
  });
  // Where the take really ended vs where the follower ended.
  let lastT = NaN;
  for (let k = total - 1; k >= 0 && Number.isNaN(lastT); k -= 1) lastT = srcTime[k];
  const end = Math.abs(live[live.length - 1].q - truthAt(c.truth, lastT)) <= tolQ || aligner.completed;
  // Post-take path vs truth: path time is on the output timeline (window centres).
  let pGood = 0;
  let pCount = 0;
  for (const [seconds, quarter] of path) {
    const s = Math.round(seconds * c.sr);
    if (s >= total || graceUntil(s)) continue;
    const t = srcTime[s];
    if (Number.isNaN(t)) continue;
    pCount += 1;
    if (Math.abs(quarter - truthAt(c.truth, t)) <= postTolQ) pGood += 1;
  }
  return { track: counted ? good / counted : 1, recover, drift, end, post: pCount ? pGood / pCount : 0, msPerFrame, postMs, recoveries: aligner.recoveries, errS };
}

function loadCase(name: string): Case {
  const dir = join(ROOT, name);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const doc = new DOMParser().parseFromString(readFileSync(join(dir, "score.musicxml"), "utf8"), "application/xml") as unknown as Document;
  const slowPath = join(STRESS, `${name}.slow70.f32`);
  return {
    name,
    sr: meta.sampleRate,
    tempo: meta.tempo,
    audio: f32(join(dir, "audio.f32")),
    slow: existsSync(slowPath) ? f32(slowPath) : null,
    truth: meta.offlinePath,
    reference: buildReference(scoreNotes(doc), meta.sampleRate),
  };
}

export function stressSuite(names: string[], options: DeviceAlignerOptions = {}, filter?: string, quiet = false) {
  const rows: { scenario: string; caseName: string; r: RunResult }[] = [];
  for (const name of names) {
    const c = loadCase(name);
    for (const s of SCENARIOS) {
      if (filter && !s.name.includes(filter) && !name.includes(filter)) continue;
      const r = run(c, s, options);
      if (!r) continue;
      rows.push({ scenario: s.name, caseName: name, r });
      if (!quiet) {
        const rec = r.recover.length ? r.recover.map((x) => (Number.isFinite(x) ? x.toFixed(1) : "never")).join("/") : "-";
        console.log(
          `  ${name.padEnd(32)} ${s.name.padEnd(18)} track ${(100 * r.track).toFixed(0).padStart(3)}%  recover ${rec.padEnd(14)} drift ${r.drift.toFixed(1).padStart(5)}  end ${r.end ? "yes" : "NO "}  post ${(100 * r.post).toFixed(0).padStart(3)}%  moves ${r.recoveries}  ${r.msPerFrame.toFixed(2)} ms/frame, post ${r.postMs.toFixed(0)} ms`,
        );
      }
    }
  }
  return rows;
}

function summarize(rows: ReturnType<typeof stressSuite>): void {
  console.log("\nby scenario (mean over takes):");
  const names = [...new Set(rows.map((r) => r.scenario))];
  for (const n of names) {
    const sel = rows.filter((r) => r.scenario === n).map((r) => r.r);
    const mean = (f: (r: RunResult) => number) => sel.reduce((a, r) => a + f(r), 0) / sel.length;
    const recs = sel.flatMap((r) => r.recover);
    const never = recs.filter((x) => !Number.isFinite(x)).length;
    const finite = recs.filter(Number.isFinite);
    const worst = finite.length ? Math.max(...finite) : 0;
    const errs = sel.flatMap((r) => r.errS).sort((a, b) => a - b);
    const pct = (p: number) => (errs.length ? errs[Math.floor(p * (errs.length - 1))] : 0).toFixed(2);
    console.log(
      `  ${n.padEnd(18)} track ${(100 * mean((r) => r.track)).toFixed(1).padStart(5)}%  err p50 ${pct(0.5)}s p90 ${pct(0.9)}s  ends ${sel.filter((r) => r.end).length}/${sel.length}  never recovered ${never}/${recs.length}  worst recovery ${worst.toFixed(1)}s  drift ${mean((r) => r.drift).toFixed(2)} qn  post ${(100 * mean((r) => r.post)).toFixed(1)}%  moves ${sel.reduce((a, r) => a + r.recoveries, 0)}`,
    );
  }
  const all = rows.map((r) => r.r);
  const mean = (f: (r: RunResult) => number) => all.reduce((a, r) => a + f(r), 0) / all.length;
  console.log(`  ${"ALL".padEnd(18)} track ${(100 * mean((r) => r.track)).toFixed(1).padStart(5)}%  ends ${all.filter((r) => r.end).length}/${all.length}  post ${(100 * mean((r) => r.post)).toFixed(1)}%  live ${mean((r) => r.msPerFrame).toFixed(2)} ms/frame`);
}

if (process.argv[1]?.includes("align-stress-harness")) {
  const args = process.argv.slice(2);
  const names = args.includes("--all") ? [...DEV, ...HELD_OUT] : DEV;
  const filter = args.find((a) => !a.startsWith("--"));
  const options: DeviceAlignerOptions = args.includes("--server") ? SERVER_BEHAVIOUR : {};
  summarize(stressSuite(names, options, filter));
}
