// The post-take alignment, as the server's LiveAligner.compute_offline_alignment + _align_stretch
// + _backtrack_from do it: the whole take's chroma (one tuning for the take), the PlayingGate over
// it, one stretch per "Jump to bar", and per stretch a full DTW against the reference (librosa's
// default steps, cityblock cost), the end chosen by length-normalized cost within 2 s of where the
// live follower finished, snapped to the last reference frame when within 0.2 s of it. Returns
// (seconds on the take's timeline, quarter) pairs -- see the long comments on those functions in
// server/matchmaker_service.py for why each step is there.
import { chromaFrames, frameCount, powerSpectrum } from "./chroma";
import { bandStatsFromPower, PlayingGate } from "./playingGate";

export type AlignmentPathPoint = [seconds: number, quarter: number];

export interface TakeSeek {
  sample: number; // position in the take where the jump happened
  target: number; // reference frame jumped to
  liveBefore: number; // live follower's frame just before the jump
  found?: boolean; // the place finder's move, not the player's "Jump to bar"
}

// A post-take alignment and how well it explains the take: the DTW cost at each stretch's chosen
// end summed, over the summed path-length normaliser the end choice uses (reference frames +
// performance frames). Lower is better; comparable between alignments of the same take.
export interface ScoredAlignment {
  path: AlignmentPathPoint[];
  cost: number;
}

const END_SEARCH_FRAMES = 2 * 30; // OFFLINE_END_SEARCH_SECONDS x the server's FRAME_RATE
const END_SNAP_FRAMES = 6;

export interface OfflineInput {
  take: Float32Array;
  sampleRate: number;
  hop: number;
  nFft: number;
  reference: Float32Array; // nRef x 12
  refFrameQuarter: ArrayLike<number>;
  seeks: TakeSeek[];
  liveFinal: number; // live follower's last frame
}

export function alignTake(input: OfflineInput): AlignmentPathPoint[] {
  const { take, sampleRate, hop, nFft, reference, refFrameQuarter } = input;
  if (take.length < nFft) return [];
  const { chroma: features, frames } = chromaFrames(take, sampleRate, hop, nFft);

  // The same gate as the live stream, over the take's frames.
  const gate = new PlayingGate<number>();
  const tonal: number[] = [];
  const S = new Float32Array((nFft >> 1) + 1);
  const statFrames = Math.min(frames, frameCount(take.length, nFft, hop));
  for (let i = 0; i < statFrames; i += 1) {
    powerSpectrum(take, i * hop, nFft, S);
    const { low, rms } = bandStatsFromPower(S, nFft, sampleRate);
    for (const released of gate.push(i, features, i * 12, low, rms)) tonal.push(released);
  }
  return alignFromFeatures(input, features, frames, tonal);
}

// The DTW half of alignTake, given the take's chroma and the frames the gate kept.
export function alignFromFeatures(input: OfflineInput, features: Float32Array, frames: number, tonal: number[]): AlignmentPathPoint[] {
  return alignScored(input, features, frames, tonal).path;
}

export function alignScored(input: OfflineInput, features: Float32Array, frames: number, tonal: number[]): ScoredAlignment {
  const { sampleRate, hop, nFft, reference, refFrameQuarter } = input;
  if (tonal.length < 2) return { path: [], cost: Infinity };
  const nRef = reference.length / 12;
  const liveFinal = Math.min(Math.max(input.liveFinal, 0), nRef - 1);
  const stretches: { lo: number; hi: number; refLo: number; liveEnd: number }[] = [];
  let start = 0;
  let refStart = 0;
  for (const seek of input.seeks) {
    stretches.push({ lo: start, hi: Math.floor(seek.sample / hop), refLo: refStart, liveEnd: seek.liveBefore });
    start = Math.floor(seek.sample / hop);
    refStart = seek.target;
  }
  stretches.push({ lo: start, hi: frames, refLo: refStart, liveEnd: liveFinal });

  const result: AlignmentPathPoint[] = [];
  let cost = 0;
  let length = 0;
  for (const { lo, hi, refLo, liveEnd } of stretches) {
    const picked = tonal.filter((f) => f >= lo && f < hi);
    if (picked.length < 2 || refLo >= nRef - 1) continue;
    const stretch = alignStretch(features, picked, reference, refFrameQuarter, refLo, Math.max(liveEnd, refLo), hop, nFft, sampleRate);
    result.push(...stretch.points);
    cost += stretch.cost;
    length += stretch.length;
  }
  return { path: result, cost: length > 0 ? cost / length : Infinity };
}

function alignStretch(
  features: Float32Array,
  frames: number[],
  reference: Float32Array,
  refFrameQuarter: ArrayLike<number>,
  refLo: number,
  liveEndIn: number,
  hop: number,
  nFft: number,
  sampleRate: number
): { points: AlignmentPathPoint[]; cost: number; length: number } {
  const nRef = reference.length / 12;
  const liveEnd = Math.min(Math.max(liveEndIn, refLo), nRef - 1);
  const endLo = Math.max(refLo + 1, liveEnd - END_SEARCH_FRAMES);
  const endHi = Math.min(nRef, liveEnd + END_SEARCH_FRAMES + 1);
  const N = endHi - refLo; // reference rows
  const M = frames.length; // performance columns

  // librosa.sequence.dtw: D[n][m] = C[n][m] + min over steps (1,1), (0,1), (1,0) -- in that order,
  // replaced only when strictly cheaper -- with D[0][0] = C[0][0]. Filled column by column
  // (every cell depends only on cells above/left of it, so the values are the same as librosa's
  // row-by-row fill); one byte per cell keeps the step taken for the backtrack, stored column by
  // column (steps[m * N + n]) so the fill writes memory in order. The 12-term distance is
  // unrolled with the additions in the same order as a loop from 0, so costs are bit-identical.
  const steps = new Uint8Array(N * M);
  let prev = new Float64Array(N);
  let cur = new Float64Array(N);
  for (let m = 0; m < M; m += 1) {
    const perfRow = frames[m] * 12;
    const p0 = features[perfRow];
    const p1 = features[perfRow + 1];
    const p2 = features[perfRow + 2];
    const p3 = features[perfRow + 3];
    const p4 = features[perfRow + 4];
    const p5 = features[perfRow + 5];
    const p6 = features[perfRow + 6];
    const p7 = features[perfRow + 7];
    const p8 = features[perfRow + 8];
    const p9 = features[perfRow + 9];
    const p10 = features[perfRow + 10];
    const p11 = features[perfRow + 11];
    const column = m * N;
    for (let n = 0; n < N; n += 1) {
      const r = (refLo + n) * 12;
      const c =
        Math.abs(reference[r] - p0) +
        Math.abs(reference[r + 1] - p1) +
        Math.abs(reference[r + 2] - p2) +
        Math.abs(reference[r + 3] - p3) +
        Math.abs(reference[r + 4] - p4) +
        Math.abs(reference[r + 5] - p5) +
        Math.abs(reference[r + 6] - p6) +
        Math.abs(reference[r + 7] - p7) +
        Math.abs(reference[r + 8] - p8) +
        Math.abs(reference[r + 9] - p9) +
        Math.abs(reference[r + 10] - p10) +
        Math.abs(reference[r + 11] - p11);
      if (n === 0 && m === 0) {
        cur[0] = c;
        steps[0] = 0;
        continue;
      }
      let best = Infinity;
      let step = n === 0 ? 1 : m === 0 ? 2 : 0; // librosa's border defaults
      const diag = n > 0 && m > 0 ? prev[n - 1] + c : Infinity;
      const left = m > 0 ? prev[n] + c : Infinity; // (0, 1): previous performance frame
      const up = n > 0 ? cur[n - 1] + c : Infinity; // (1, 0): previous reference frame
      if (diag < best) {
        best = diag;
        step = 0;
      }
      if (left < best) {
        best = left;
        step = 1;
      }
      if (up < best) {
        best = up;
        step = 2;
      }
      cur[n] = best;
      steps[column + n] = step;
    }
    [prev, cur] = [cur, prev];
  }
  const finalColumn = prev; // D[:, M - 1]

  let end = endLo;
  let bestNorm = Infinity;
  for (let cand = endLo; cand < endHi; cand += 1) {
    const norm = finalColumn[cand - refLo] / (cand - refLo + 1 + M);
    if (norm < bestNorm) {
      bestNorm = norm;
      end = cand;
    }
  }
  if (endHi === nRef && end >= nRef - 1 - END_SNAP_FRAMES) end = nRef - 1;

  // _backtrack_from: from (end, last column) back to (0, 0).
  const path: [number, number][] = [];
  let i = end - refLo;
  let j = M - 1;
  path.push([i, j]);
  while (i > 0 || j > 0) {
    if (i === 0) j -= 1;
    else if (j === 0) i -= 1;
    else {
      const s = steps[j * N + i];
      if (s === 0) {
        i -= 1;
        j -= 1;
      } else if (s === 1) j -= 1;
      else i -= 1;
    }
    path.push([i, j]);
  }
  path.reverse();

  // One point per performance frame, at the middle of the reference frames it maps to.
  const spans = new Map<number, number[]>();
  for (const [r, p] of path) {
    const list = spans.get(p);
    if (list) list.push(r + refLo);
    else spans.set(p, [r + refLo]);
  }
  const out: AlignmentPathPoint[] = [];
  const centre = nFft / 2;
  for (const p of [...spans.keys()].sort((a, b) => a - b)) {
    const refs = spans.get(p) as number[];
    const ref = Math.min(refs[refs.length >> 1], refFrameQuarter.length - 1);
    out.push([(frames[p] * hop + centre) / sampleRate, refFrameQuarter[ref]]);
  }
  return { points: out, cost: finalColumn[end - refLo], length: end - refLo + 1 + M };
}
