// Real FFT of any even length. The alignment's chroma uses n_fft = 2 x hop = 2 x round(rate / 30):
// 3200 points at 48 kHz, 2940 at 44.1 kHz -- not powers of two -- and must match librosa's FFT of
// exactly that length. A real input of length n is packed into a complex sequence of n/2 points
// (even samples real, odd imaginary), transformed, and unpacked. The complex transform is a
// mixed-radix Stockham FFT when the length has only small prime factors (1600 = 2^6 5^2,
// 1470 = 2 3 5 7^2 -- every rate a phone records at), else Bluestein's algorithm over the radix-2
// FFT in audio/fft.ts. Mixed radix is several times faster than Bluestein here and slightly more
// exact. Plans and buffers are kept per size: this runs ~60 times a second live.
import { fftInPlace } from "../../audio/fft";

interface ComplexPlan {
  n: number;
  m: number; // Bluestein length (power of two >= 2n - 1); 0 when n itself is a power of two
  wRe: Float64Array; // chirp exp(-i*pi*k^2/n)
  wIm: Float64Array;
  bRe: Float64Array; // FFT of the conjugate chirp, wrapped to length m
  bIm: Float64Array;
  aRe: Float64Array; // work buffers, length m (or n)
  aIm: Float64Array;
}

const complexPlans = new Map<number, ComplexPlan>();

function complexPlan(n: number): ComplexPlan {
  let p = complexPlans.get(n);
  if (p) return p;
  if ((n & (n - 1)) === 0) {
    p = { n, m: 0, wRe: new Float64Array(0), wIm: new Float64Array(0), bRe: new Float64Array(0), bIm: new Float64Array(0), aRe: new Float64Array(n), aIm: new Float64Array(n) };
    complexPlans.set(n, p);
    return p;
  }
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const wRe = new Float64Array(n);
  const wIm = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    // k^2 mod 2n keeps the angle small, so the chirp stays exact for large k.
    const angle = (Math.PI * ((k * k) % (2 * n))) / n;
    wRe[k] = Math.cos(angle);
    wIm[k] = -Math.sin(angle);
  }
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);
  bRe[0] = wRe[0];
  bIm[0] = -wIm[0];
  for (let k = 1; k < n; k += 1) {
    bRe[k] = bRe[m - k] = wRe[k];
    bIm[k] = bIm[m - k] = -wIm[k];
  }
  fftInPlace(bRe, bIm);
  p = { n, m, wRe, wIm, bRe, bIm, aRe: new Float64Array(m), aIm: new Float64Array(m) };
  complexPlans.set(n, p);
  return p;
}

// ---- mixed radix (Stockham, decimation in frequency, self-sorting) -------------------------------

interface Stage {
  p: number; // radix
  s: number; // stride: product of the radices before this stage
  m: number; // n / (s * p)
  twRe: Float64Array; // W_{m p}^(r j), index r * m + j
  twIm: Float64Array;
  omRe: Float64Array; // W_p^k, k < p
  omIm: Float64Array;
  rootIndex: Int32Array; // (q r) mod p at r * p + q
}

interface MixedPlan {
  stages: Stage[];
  xRe: Float64Array;
  xIm: Float64Array;
  yRe: Float64Array;
  yIm: Float64Array;
  aRe: Float64Array; // per-butterfly scratch (largest radix)
  aIm: Float64Array;
}

const MAX_RADIX = 13;
const mixedPlans = new Map<number, MixedPlan | null>();

function mixedPlan(n: number): MixedPlan | null {
  if (mixedPlans.has(n)) return mixedPlans.get(n) ?? null;
  const radices: number[] = [];
  let rest = n;
  while (rest % 4 === 0) {
    radices.push(4);
    rest /= 4;
  }
  for (const f of [2, 3, 5, 7, 11, 13]) {
    while (rest % f === 0) {
      radices.push(f);
      rest /= f;
    }
  }
  if (rest !== 1 || n < 2) {
    mixedPlans.set(n, null);
    return null;
  }
  const stages: Stage[] = [];
  let s = 1;
  for (const p of radices) {
    const m = n / (s * p);
    const twRe = new Float64Array(p * m);
    const twIm = new Float64Array(p * m);
    for (let r = 0; r < p; r += 1) {
      for (let j = 0; j < m; j += 1) {
        const angle = (-2 * Math.PI * ((r * j) % (m * p))) / (m * p);
        twRe[r * m + j] = Math.cos(angle);
        twIm[r * m + j] = Math.sin(angle);
      }
    }
    const omRe = new Float64Array(p);
    const omIm = new Float64Array(p);
    for (let k = 0; k < p; k += 1) {
      omRe[k] = Math.cos((-2 * Math.PI * k) / p);
      omIm[k] = Math.sin((-2 * Math.PI * k) / p);
    }
    const rootIndex = new Int32Array(p * p);
    for (let r = 0; r < p; r += 1) for (let q = 0; q < p; q += 1) rootIndex[r * p + q] = (q * r) % p;
    stages.push({ p, s, m, twRe, twIm, omRe, omIm, rootIndex });
    s *= p;
  }
  const plan: MixedPlan = {
    stages,
    xRe: new Float64Array(n),
    xIm: new Float64Array(n),
    yRe: new Float64Array(n),
    yIm: new Float64Array(n),
    aRe: new Float64Array(MAX_RADIX),
    aIm: new Float64Array(MAX_RADIX),
  };
  mixedPlans.set(n, plan);
  return plan;
}

// One Stockham pass: for each j < m and k < s, the p inputs x[k + s (j + q m)] go through a
// size-p DFT, are twiddled by W_{m p}^(r j) and land at y[k + s (p j + r)].
function mixedStage(st: Stage, xRe: Float64Array, xIm: Float64Array, yRe: Float64Array, yIm: Float64Array, aRe: Float64Array, aIm: Float64Array): void {
  const { p, s, m, twRe, twIm, omRe, omIm, rootIndex } = st;
  const sm = s * m;
  for (let j = 0; j < m; j += 1) {
    for (let k = 0; k < s; k += 1) {
      const inBase = k + s * j;
      const outBase = k + s * p * j;
      if (p === 2) {
        const a0r = xRe[inBase];
        const a0i = xIm[inBase];
        const a1r = xRe[inBase + sm];
        const a1i = xIm[inBase + sm];
        yRe[outBase] = a0r + a1r;
        yIm[outBase] = a0i + a1i;
        const dr = a0r - a1r;
        const di = a0i - a1i;
        const wr = twRe[m + j];
        const wi = twIm[m + j];
        yRe[outBase + s] = dr * wr - di * wi;
        yIm[outBase + s] = dr * wi + di * wr;
        continue;
      }
      if (p === 4) {
        const a0r = xRe[inBase];
        const a0i = xIm[inBase];
        const a1r = xRe[inBase + sm];
        const a1i = xIm[inBase + sm];
        const a2r = xRe[inBase + 2 * sm];
        const a2i = xIm[inBase + 2 * sm];
        const a3r = xRe[inBase + 3 * sm];
        const a3i = xIm[inBase + 3 * sm];
        const t0r = a0r + a2r;
        const t0i = a0i + a2i;
        const t1r = a0r - a2r;
        const t1i = a0i - a2i;
        const t2r = a1r + a3r;
        const t2i = a1i + a3i;
        // (a1 - a3) times -i
        const t3r = a1i - a3i;
        const t3i = a3r - a1r;
        const b1r = t1r + t3r;
        const b1i = t1i + t3i;
        const b2r = t0r - t2r;
        const b2i = t0i - t2i;
        const b3r = t1r - t3r;
        const b3i = t1i - t3i;
        yRe[outBase] = t0r + t2r;
        yIm[outBase] = t0i + t2i;
        let wr = twRe[m + j];
        let wi = twIm[m + j];
        yRe[outBase + s] = b1r * wr - b1i * wi;
        yIm[outBase + s] = b1r * wi + b1i * wr;
        wr = twRe[2 * m + j];
        wi = twIm[2 * m + j];
        yRe[outBase + 2 * s] = b2r * wr - b2i * wi;
        yIm[outBase + 2 * s] = b2r * wi + b2i * wr;
        wr = twRe[3 * m + j];
        wi = twIm[3 * m + j];
        yRe[outBase + 3 * s] = b3r * wr - b3i * wi;
        yIm[outBase + 3 * s] = b3r * wi + b3i * wr;
        continue;
      }
      let a0r = 0;
      let a0i = 0;
      for (let q = 0; q < p; q += 1) {
        aRe[q] = xRe[inBase + q * sm];
        aIm[q] = xIm[inBase + q * sm];
        a0r += aRe[q];
        a0i += aIm[q];
      }
      // r = 0 needs no roots; the rest read W_p^(q r mod p) from the stage's table.
      yRe[outBase] = a0r;
      yIm[outBase] = a0i;
      for (let r = 1; r < p; r += 1) {
        let br = aRe[0];
        let bi = aIm[0];
        const row = r * p;
        for (let q = 1; q < p; q += 1) {
          const e = rootIndex[row + q];
          const wr0 = omRe[e];
          const wi0 = omIm[e];
          br += aRe[q] * wr0 - aIm[q] * wi0;
          bi += aRe[q] * wi0 + aIm[q] * wr0;
        }
        const wr = twRe[r * m + j];
        const wi = twIm[r * m + j];
        yRe[outBase + r * s] = br * wr - bi * wi;
        yIm[outBase + r * s] = br * wi + bi * wr;
      }
    }
  }
}

function mixedDft(plan: MixedPlan, re: Float64Array, im: Float64Array, n: number): void {
  let xRe = plan.xRe;
  let xIm = plan.xIm;
  let yRe = plan.yRe;
  let yIm = plan.yIm;
  xRe.set(re.subarray(0, n));
  xIm.set(im.subarray(0, n));
  for (const st of plan.stages) {
    mixedStage(st, xRe, xIm, yRe, yIm, plan.aRe, plan.aIm);
    [xRe, yRe] = [yRe, xRe];
    [xIm, yIm] = [yIm, xIm];
  }
  re.set(xRe);
  im.set(xIm);
}

// In-place complex DFT of length n (any n).
export function complexDft(re: Float64Array, im: Float64Array, n: number): void {
  if ((n & (n - 1)) !== 0) {
    const mixed = mixedPlan(n);
    if (mixed) {
      mixedDft(mixed, re, im, n);
      return;
    }
  }
  const p = complexPlan(n);
  if (p.m === 0) {
    fftInPlace(re, im);
    return;
  }
  const { m, wRe, wIm, bRe, bIm, aRe, aIm } = p;
  for (let k = 0; k < n; k += 1) {
    aRe[k] = re[k] * wRe[k] - im[k] * wIm[k];
    aIm[k] = re[k] * wIm[k] + im[k] * wRe[k];
  }
  aRe.fill(0, n);
  aIm.fill(0, n);
  fftInPlace(aRe, aIm);
  for (let k = 0; k < m; k += 1) {
    const r = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    const i = aRe[k] * bIm[k] + aIm[k] * bRe[k];
    // Conjugate before and after a forward FFT = inverse FFT (scaled by m).
    aRe[k] = r;
    aIm[k] = -i;
  }
  fftInPlace(aRe, aIm);
  for (let k = 0; k < n; k += 1) {
    const cRe = aRe[k] / m;
    const cIm = -aIm[k] / m;
    re[k] = cRe * wRe[k] - cIm * wIm[k];
    im[k] = cRe * wIm[k] + cIm * wRe[k];
  }
}

interface RealPlan {
  half: number;
  zRe: Float64Array;
  zIm: Float64Array;
  tRe: Float64Array; // exp(-2*pi*i*k/n), k <= n/2
  tIm: Float64Array;
}

const realPlans = new Map<number, RealPlan>();

function realPlan(n: number): RealPlan {
  let p = realPlans.get(n);
  if (p) return p;
  const half = n >> 1;
  const tRe = new Float64Array(half + 1);
  const tIm = new Float64Array(half + 1);
  for (let k = 0; k <= half; k += 1) {
    tRe[k] = Math.cos((-2 * Math.PI * k) / n);
    tIm[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  p = { half, zRe: new Float64Array(half), zIm: new Float64Array(half), tRe, tIm };
  realPlans.set(n, p);
  return p;
}

// Bins 0..n/2 of the DFT of a real input of even length n, written into outRe/outIm.
export function realDft(input: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
  const n = input.length;
  if (n % 2 !== 0) throw new Error("realDft: length must be even");
  const { half, zRe, zIm, tRe, tIm } = realPlan(n);
  for (let k = 0; k < half; k += 1) {
    zRe[k] = input[2 * k];
    zIm[k] = input[2 * k + 1];
  }
  complexDft(zRe, zIm, half);
  for (let k = 0; k <= half; k += 1) {
    const a = k % half;
    const b = (half - k) % half;
    // E = (Z[k] + conj Z[half-k]) / 2 (even samples), O = (Z[k] - conj Z[half-k]) / 2i (odd)
    const eRe = (zRe[a] + zRe[b]) / 2;
    const eIm = (zIm[a] - zIm[b]) / 2;
    const oRe = (zIm[a] + zIm[b]) / 2;
    const oIm = -(zRe[a] - zRe[b]) / 2;
    outRe[k] = eRe + tRe[k] * oRe - tIm[k] * oIm;
    outIm[k] = eIm + tRe[k] * oIm + tIm[k] * oRe;
  }
}
