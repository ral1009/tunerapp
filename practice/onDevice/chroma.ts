// Chroma features exactly as the alignment server computes them: matchmaker's ChromagramProcessor,
// which is librosa.feature.chroma_stft(sr, hop, n_fft = 2 x hop, center=False, norm=inf) with
// tuning=None -- so librosa first ESTIMATES the tuning from the spectrogram it was given (piptrack
// peaks -> a 0.01-bin histogram of their pitch residuals) and builds its chroma filter bank at that
// tuning. Live, the processor sees one frame at a time, so tuning is estimated per frame; for the
// reference and the post-take pass it sees the whole signal, so one tuning covers every frame.
//
// librosa does this in float32 (the STFT is stored as complex64, the spectrogram and filter bank
// are float32), and small numeric differences matter here: tuning is a histogram argmax and
// piptrack keeps local maxima, both of which can flip on a near tie. So the float32 roundings are
// reproduced with Math.fround where librosa/numpy round.
import { realDft } from "./fftAny";

const fround = Math.fround;
const FLOAT32_TINY = 1.1754943508222875e-38;

// scipy.signal.get_window("hann", n, fftbins=True): the periodic Hann window librosa uses.
const windows = new Map<number, Float64Array>();
export function periodicHann(n: number): Float64Array {
  let w = windows.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let k = 0; k < n; k += 1) w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / n);
    windows.set(n, w);
  }
  return w;
}

// |STFT|^2 of one frame as librosa stores it: window (float64) x samples, rfft, rounded to
// complex64, |.| in float32, squared in float32.
const scratch = new Map<number, { x: Float64Array; re: Float64Array; im: Float64Array }>();
export function dftScratch(n: number): { x: Float64Array; re: Float64Array; im: Float64Array } {
  let s = scratch.get(n);
  if (!s) {
    const bins = (n >> 1) + 1;
    s = { x: new Float64Array(n), re: new Float64Array(bins), im: new Float64Array(bins) };
    scratch.set(n, s);
  }
  return s;
}

export function powerSpectrum(samples: Float32Array, offset: number, n: number, out?: Float32Array): Float32Array {
  const w = periodicHann(n);
  const { x, re, im } = dftScratch(n);
  for (let k = 0; k < n; k += 1) x[k] = w[k] * samples[offset + k];
  const bins = (n >> 1) + 1;
  realDft(x, re, im);
  const S = out ?? new Float32Array(bins);
  for (let k = 0; k < bins; k += 1) {
    const r = fround(re[k]);
    const i = fround(im[k]);
    const mag = fround(Math.sqrt(r * r + i * i));
    S[k] = fround(mag * mag);
  }
  return S;
}

// The live gate's band stats (playingGate.ts bandStats: energy at 60-180 Hz over 180-4000 Hz,
// and rms) from the spectrum powerSpectrum() just computed -- its unrounded float64 bins -- so a
// live frame needs one FFT, not two. bandStats windows in float32 like the server's stream; this
// windows in float64: a ~1e-8 relative difference, and the parity harness checks the gate's
// decisions still match the server's frame for frame.
export function lastSpectrumBandStats(n: number, sampleRate: number): { low: number; rms: number } {
  const { re, im } = dftScratch(n);
  const bins = (n >> 1) + 1;
  let low = 0;
  let band = 0;
  let total = 0;
  for (let k = 0; k < bins; k += 1) {
    const p = re[k] * re[k] + im[k] * im[k];
    const f = (k * sampleRate) / n;
    if (f > 60 && f < 180) low += p;
    if (f >= 180 && f < 4000) band += p;
    total += p;
  }
  return { low: low / (band + 1e-12), rms: Math.sqrt(total / n) };
}

// librosa.piptrack on a power spectrum column: (pitch, magnitude) of each thresholded local
// maximum between 150 Hz and min(4000, sr/2). Appends to pitches/mags.
export function piptrackFrame(S: Float32Array, sampleRate: number, n: number, pitches: number[], mags: number[]): void {
  const bins = S.length;
  const fmax = Math.min(4000, sampleRate / 2);
  let max = 0;
  for (let k = 0; k < bins; k += 1) if (S[k] > max) max = S[k];
  const ref = fround(0.1 * max);
  const masked = (k: number) => (S[k] > ref ? S[k] : 0);
  for (let k = 1; k < bins; k += 1) {
    const f = (k * sampleRate) / n;
    if (f < 150 || f >= fmax) continue;
    const x0 = masked(k);
    const isMax = k === bins - 1 ? x0 > masked(k - 1) : x0 > masked(k - 1) && x0 >= masked(k + 1);
    if (!isMax) continue;
    // Parabolic shift (numba, float64 arithmetic, stored float32); edges are 0.
    let shift = 0;
    let avg: number;
    if (k === bins - 1) {
      avg = fround(S[k] - S[k - 1]);
    } else {
      const a = S[k + 1] + S[k - 1] - 2 * S[k];
      const b = (S[k + 1] - S[k - 1]) / 2;
      shift = Math.abs(b) >= Math.abs(a) ? 0 : fround(-b / a);
      avg = fround(fround(S[k + 1] - S[k - 1]) / 2); // numpy.gradient, float32
    }
    const dskew = fround(fround(0.5 * avg) * shift);
    pitches.push(fround(((k + shift) * sampleRate) / n));
    mags.push(fround(S[k] + dskew));
  }
}

// numpy.median of float32 values (float32 result).
function medianFloat32(values: number[]): number {
  const sorted = Float32Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : fround((sorted[mid - 1] + sorted[mid]) / 2);
}

// Histogram edges as numpy.linspace(-0.5, 0.5, 101) makes them.
const TUNING_EDGES = (() => {
  const edges = new Float64Array(101);
  for (let i = 0; i < 101; i += 1) edges[i] = i * 0.01 + -0.5;
  edges[100] = 0.5;
  return edges;
})();

// librosa.estimate_tuning from piptrack output (bins_per_octave 12, resolution 0.01).
export function estimateTuning(pitches: number[], mags: number[]): number {
  if (pitches.length === 0) return 0;
  const threshold = medianFloat32(mags);
  const counts = new Int32Array(100);
  let any = false;
  for (let i = 0; i < pitches.length; i += 1) {
    if (!(mags[i] >= threshold) || !(pitches[i] > 0)) continue;
    // 12 * log2(f / (440/16)) mod 1, float32 throughout.
    const octs = fround(Math.log2(fround(pitches[i] / 27.5)));
    let residual = fround(fround(12 * octs) % 1);
    if (residual < 0) residual = fround(residual + 1);
    if (residual >= 0.5) residual = fround(residual - 1);
    if (residual < -0.5 || residual > 0.5) continue;
    let index = Math.min(99, Math.floor((residual + 0.5) * 100));
    if (residual < TUNING_EDGES[index]) index -= 1;
    else if (index < 99 && residual >= TUNING_EDGES[index + 1]) index += 1;
    counts[index] += 1;
    any = true;
  }
  if (!any) return 0;
  let best = 0;
  for (let i = 1; i < 100; i += 1) if (counts[i] > counts[best]) best = i;
  return TUNING_EDGES[best];
}

// librosa.filters.chroma(sr, n_fft, tuning, n_chroma=12, ctroct=5, octwidth=2, norm=2,
// base_c=True), float32, shape 12 x (n_fft/2 + 1), flattened row-major.
const filterBanks = new Map<string, Float32Array>();
export function chromaFilterBank(sampleRate: number, n: number, tuning: number): Float32Array {
  const key = `${sampleRate}:${n}:${tuning}`;
  const cached = filterBanks.get(key);
  if (cached) return cached;
  const a440 = 440 * 2 ** (tuning / 12);
  const frqbins = new Float64Array(n);
  for (let k = 1; k < n; k += 1) frqbins[k] = 12 * Math.log2(((k * sampleRate) / n) / (a440 / 16));
  frqbins[0] = frqbins[1] - 18;
  const width = new Float64Array(n);
  for (let j = 0; j < n - 1; j += 1) width[j] = Math.max(frqbins[j + 1] - frqbins[j], 1);
  width[n - 1] = 1;
  const wts = new Float64Array(12 * n);
  for (let j = 0; j < n; j += 1) {
    let norm = 0;
    for (let c = 0; c < 12; c += 1) {
      let d = frqbins[j] - c + 6 + 120;
      d = d - 12 * Math.floor(d / 12) - 6; // numpy.remainder: sign of the divisor
      const v = Math.exp(-0.5 * ((2 * d) / width[j]) ** 2);
      wts[c * n + j] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    const oct = Math.exp(-0.5 * ((frqbins[j] / 12 - 5) / 2) ** 2);
    for (let c = 0; c < 12; c += 1) wts[c * n + j] = (norm < 2.2250738585072014e-308 ? wts[c * n + j] : wts[c * n + j] / norm) * oct;
  }
  const bins = (n >> 1) + 1;
  const bank = new Float32Array(12 * bins);
  for (let c = 0; c < 12; c += 1) {
    const from = (c + 3) % 12; // np.roll(wts, -3, axis=0)
    for (let j = 0; j < bins; j += 1) bank[c * bins + j] = wts[from * n + j];
  }
  filterBanks.set(key, bank);
  return bank;
}

// Filter bank x power spectrum (float32), then librosa.util.normalize(norm=inf).
export function chromaFromPower(S: Float32Array, bank: Float32Array, out: Float32Array, outOffset = 0): void {
  const bins = S.length;
  let max = 0;
  for (let c = 0; c < 12; c += 1) {
    let sum = 0;
    const row = c * bins;
    for (let j = 0; j < bins; j += 1) sum = fround(sum + fround(bank[row + j] * S[j]));
    out[outOffset + c] = sum;
    if (Math.abs(sum) > max) max = Math.abs(sum);
  }
  const length = max < FLOAT32_TINY ? 1 : max;
  for (let c = 0; c < 12; c += 1) out[outOffset + c] = fround(out[outOffset + c] / length);
}

export function frameCount(length: number, n: number, hop: number): number {
  return length < n ? 0 : 1 + Math.floor((length - n) / hop);
}

// chroma_stft over a whole signal (center=False): one tuning estimated from every frame.
// Returns frames x 12, row-major. Two passes (peaks, then chroma) rather than keeping the whole
// spectrogram: a few minutes of audio would otherwise hold tens of MB of spectra.
export function chromaFrames(audio: Float32Array, sampleRate: number, hop: number, n: number): { chroma: Float32Array; frames: number; tuning: number } {
  const frames = frameCount(audio.length, n, hop);
  const S = new Float32Array((n >> 1) + 1);
  const pitches: number[] = [];
  const mags: number[] = [];
  for (let t = 0; t < frames; t += 1) {
    powerSpectrum(audio, t * hop, n, S);
    piptrackFrame(S, sampleRate, n, pitches, mags);
  }
  const tuning = estimateTuning(pitches, mags);
  const bank = chromaFilterBank(sampleRate, n, tuning);
  const chroma = new Float32Array(frames * 12);
  for (let t = 0; t < frames; t += 1) {
    powerSpectrum(audio, t * hop, n, S);
    chromaFromPower(S, bank, chroma, t * 12);
  }
  return { chroma, frames, tuning };
}

// One live frame (the processor called on exactly n samples): tuning from this frame alone.
export function chromaOfFrame(samples: Float32Array, offset: number, sampleRate: number, n: number, S?: Float32Array): { chroma: Float32Array; tuning: number; power: Float32Array } {
  const power = powerSpectrum(samples, offset, n, S);
  const pitches: number[] = [];
  const mags: number[] = [];
  piptrackFrame(power, sampleRate, n, pitches, mags);
  const tuning = estimateTuning(pitches, mags);
  const chroma = new Float32Array(12);
  chromaFromPower(power, chromaFilterBank(sampleRate, n, tuning), chroma);
  return { chroma, tuning, power };
}
