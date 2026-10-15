// The server's PlayingGate (server/matchmaker_service.py), unchanged in behaviour: which chroma
// frames are the violin being played, as opposed to silence, noise, talking or a bumped violin.
// See the comment block above PLAYING_GATE_OPEN_FRAMES there for how each threshold was set.
import { dftScratch, periodicHann } from "./chroma";
import { realDft } from "./fftAny";

export const REJECT_CHROMA_FLATNESS = 0.5;
const OPEN_FRAMES = 4;
const STABILITY = 0.9;
const OPEN_LEVEL_RATIO = 0.9;
const RESUME_FRAMES = 3;
const LOW_BAND_MAX = 0.05;
const BACKFILL_FRAMES = 15;

// True when one pitch class stands out (max-normalized mean <= 0.5); digital silence is not tonal.
export function isTonalFrame(chroma: ArrayLike<number>, offset = 0): boolean {
  let peak = 0;
  let sum = 0;
  for (let c = 0; c < 12; c += 1) {
    const v = chroma[offset + c];
    if (v > peak) peak = v;
    sum += v;
  }
  return peak > 0 && sum / 12 / peak <= REJECT_CHROMA_FLATNESS;
}

// frame_band_stats for one frame: energy at 60-180 Hz over 180-4000 Hz, and rms, from the
// Hann-windowed power spectrum of the frame's n samples.
export function bandStats(samples: Float32Array, offset: number, n: number, sampleRate: number): { low: number; rms: number } {
  const w = periodicHann(n);
  const { x, re, im } = dftScratch(n);
  for (let k = 0; k < n; k += 1) x[k] = Math.fround(samples[offset + k] * Math.fround(w[k]));
  const bins = (n >> 1) + 1;
  realDft(x, re, im);
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

// The same stats from a power spectrum already computed the way librosa.stft stores it (the
// post-take pass takes them from librosa's STFT, summed in float32).
export function bandStatsFromPower(S: Float32Array, n: number, sampleRate: number): { low: number; rms: number } {
  let low = 0;
  let band = 0;
  let total = 0;
  for (let k = 0; k < S.length; k += 1) {
    const f = (k * sampleRate) / n;
    if (f > 60 && f < 180) low = Math.fround(low + S[k]);
    if (f >= 180 && f < 4000) band = Math.fround(band + S[k]);
    total = Math.fround(total + S[k]);
  }
  return { low: Math.fround(low / Math.fround(band + 1e-12)), rms: Math.fround(Math.sqrt(Math.fround(total / n))) };
}

export class PlayingGate<T> {
  open = false;
  accepted = 0;
  rejected = 0;
  private recent: { tonal: boolean; unit: Float32Array; rms: number }[] = [];
  private pending: T[] = [];
  private sinceClosed = RESUME_FRAMES + 1;

  private stable(k: number): boolean {
    if (this.recent.length < k) return false;
    const window = this.recent.slice(-k);
    if (!window.every((r) => r.tonal)) return false;
    for (let i = 0; i + 1 < window.length; i += 1) {
      let dot = 0;
      for (let c = 0; c < 12; c += 1) dot = Math.fround(dot + Math.fround(window[i].unit[c] * window[i + 1].unit[c]));
      if (!(dot >= STABILITY)) return false;
    }
    return true;
  }

  // One frame in; the items to pass on now (usually [] or [item]; on opening, the frames that
  // led up to it).
  push(item: T, chroma: ArrayLike<number>, chromaOffset: number, lowRatio: number, rms: number): T[] {
    const tonal = isTonalFrame(chroma, chromaOffset) && lowRatio <= LOW_BAND_MAX;
    // numpy: float(np.linalg.norm(float32 chroma)) + 1e-9, the norm itself in float32.
    let norm = 0;
    for (let c = 0; c < 12; c += 1) norm = Math.fround(norm + Math.fround(chroma[chromaOffset + c] * chroma[chromaOffset + c]));
    const denom = Math.fround(Math.sqrt(norm)) + 1e-9;
    const unit = new Float32Array(12);
    for (let c = 0; c < 12; c += 1) unit[c] = chroma[chromaOffset + c] / denom;
    this.recent.push({ tonal, unit, rms });
    if (this.recent.length > OPEN_FRAMES) this.recent.splice(0, this.recent.length - OPEN_FRAMES);

    if (!this.open) {
      if (!tonal) {
        this.sinceClosed += 1;
        this.rejected += this.pending.length + 1;
        this.pending = [];
        return [];
      }
      this.pending.push(item);
      if (this.pending.length > BACKFILL_FRAMES) {
        this.pending.shift();
        this.rejected += 1;
      }
      const levels = this.recent.map((r) => r.rms);
      const resuming = this.sinceClosed <= RESUME_FRAMES;
      this.sinceClosed += 1;
      if (resuming || (this.stable(OPEN_FRAMES) && levels[levels.length - 1] >= OPEN_LEVEL_RATIO * Math.max(...levels))) {
        this.open = true;
        const released = this.pending;
        this.pending = [];
        this.accepted += released.length;
        return released;
      }
      return [];
    }

    if (!tonal) {
      this.open = false;
      this.sinceClosed = 1;
      this.rejected += 1;
      return [];
    }
    this.accepted += 1;
    return [item];
  }
}
