// Real FFT of any even length. The alignment's chroma uses n_fft = 2 x hop = 2 x round(rate / 30):
// 3200 points at 48 kHz, 2940 at 44.1 kHz -- not powers of two -- and must match librosa's FFT of
// exactly that length. A real input of length n is packed into a complex sequence of n/2 points
// (even samples real, odd imaginary), transformed with Bluestein's algorithm over the radix-2 FFT
// in audio/fft.ts, and unpacked. Buffers are kept per size: this runs ~60 times a second live.
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

// In-place complex DFT of length n (any n).
function complexDft(re: Float64Array, im: Float64Array, n: number): void {
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
