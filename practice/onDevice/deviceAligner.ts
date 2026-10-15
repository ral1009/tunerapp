// One score-following session on the device: the counterpart of the server's LiveAligner, with
// the same results (checked frame by frame against it -- practice/__tests__/device-align-harness.ts).
// Microphone samples in (any chunk size), score positions in quarter notes out; after the take,
// the post-take alignment path the grader uses.
//
// Built once per score: the note list (score/scoreNotes.ts), the additive reference and its
// chroma (referenceAudio.ts, chroma.ts). Live, each hop of audio becomes one chroma frame
// (tuning estimated from that frame, as the server's per-call processor does), goes through the
// playing gate and into the Arzt follower. Everything the post-take pass needs from those frames
// is kept as it goes -- their spectral peaks (for the take's overall tuning), the gate's band
// stats, and their chroma -- so at the end only frames whose own tuning differs from the take's
// need their spectrum recomputed.
import type { ScoreNotes } from "../../score/scoreNotes";
import { ArztFollower } from "./arztFollower";
import { chromaFilterBank, chromaFrames, chromaFromPower, estimateTuning, piptrackFrame, powerSpectrum } from "./chroma";
import { alignFromFeatures, type AlignmentPathPoint, type TakeSeek } from "./offlineAlign";
import { bandStats, bandStatsFromPower, PlayingGate } from "./playingGate";
import { referenceAudio, refFrameQuarters } from "./referenceAudio";

// The server's FRAME_RATE: hop = round(sampleRate / 30).
export const ALIGNMENT_FRAME_RATE = 30;

export interface AlignmentReference {
  sampleRate: number;
  hop: number;
  nFft: number;
  chroma: Float32Array; // frames x 12
  frameQuarter: Float64Array;
  quarterOrigin: number;
  totalQuarters: number;
  lastOnsetQuarter: number;
}

export function buildReference(score: ScoreNotes, sampleRate: number): AlignmentReference {
  const hop = Math.max(1, Math.round(sampleRate / ALIGNMENT_FRAME_RATE));
  const nFft = 2 * hop;
  const audio = referenceAudio(score.notes, score.tempo, sampleRate, { meter: score.meter, quarterOrigin: score.quarterOrigin });
  const { chroma, frames } = chromaFrames(audio, sampleRate, hop, nFft);
  const lastOnsetQuarter = score.notes.length ? Math.max(...score.notes.map((n) => n.onsetQuarter)) : 0;
  return {
    sampleRate,
    hop,
    nFft,
    chroma,
    frameQuarter: refFrameQuarters(frames, sampleRate / hop, score.tempo, score.quarterOrigin),
    quarterOrigin: score.quarterOrigin,
    totalQuarters: score.totalQuarters,
    lastOnsetQuarter
  };
}

export class DeviceAligner {
  readonly reference: AlignmentReference;
  private readonly follower: ArztFollower;
  private readonly gate = new PlayingGate<number>();
  private readonly hop: number;
  private readonly nFft: number;
  private readonly sampleRate: number;
  // The take: exactly the hop-sized chunks that were analysed, back to back.
  private takeChunks: Float32Array[] = [];
  private pending = new Float32Array(0);
  private previous: Float32Array | null = null;
  private readonly frame: Float32Array;
  private readonly S: Float32Array;
  // Per analysed frame, kept for the post-take pass.
  private liveChroma: number[] = [];
  private frameTuning: number[] = [];
  private framePeakStart: number[] = [];
  private peakPitches: number[] = [];
  private peakMags: number[] = [];
  private offlineLow: number[] = [];
  private offlineRms: number[] = [];
  private seeks: TakeSeek[] = [];
  private lastQuarter: number | null = null;
  completed = false;

  constructor(reference: AlignmentReference) {
    this.reference = reference;
    this.sampleRate = reference.sampleRate;
    this.hop = reference.hop;
    this.nFft = reference.nFft;
    this.follower = new ArztFollower(reference.chroma, this.sampleRate / this.hop);
    this.frame = new Float32Array(this.nFft);
    this.S = new Float32Array((this.nFft >> 1) + 1);
  }

  get hopLength(): number {
    return this.hop;
  }

  get frames(): number {
    return this.frameTuning.length;
  }

  stats(): { accepted: number; rejected: number } {
    return { accepted: this.gate.accepted, rejected: this.gate.rejected };
  }

  quarterOfFrame(frame: number): number {
    const q = this.reference.frameQuarter;
    return q[Math.min(Math.max(frame, 0), q.length - 1)];
  }

  // The server's quarter_to_ref_frame: the first reference frame at or after the quarter.
  frameOfQuarter(quarter: number): number {
    const q = this.reference.frameQuarter;
    const target = Math.min(Math.max(quarter, this.reference.quarterOrigin), this.reference.totalQuarters);
    let lo = 0;
    let hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (q[mid] < target - 1e-9) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, q.length - 1);
  }

  // "Jump to bar": the live follower restarts there, and the post-take pass aligns the audio
  // before and after the jump separately.
  seek(quarter: number): void {
    const target = this.frameOfQuarter(quarter);
    this.seeks.push({ sample: this.takeChunks.length * this.hop, target, liveBefore: this.follower.currentFrame });
    this.follower.seek(target);
    this.completed = false;
  }

  // Microphone samples in. Returns the score position after this audio when it changed (the
  // server likewise only reports a position when it moves), else null.
  push(samples: Float32Array): number | null {
    let buffer = samples;
    if (this.pending.length) {
      buffer = new Float32Array(this.pending.length + samples.length);
      buffer.set(this.pending);
      buffer.set(samples, this.pending.length);
    }
    let offset = 0;
    let moved: number | null = null;
    while (buffer.length - offset >= this.hop) {
      const q = this.processChunk(buffer.slice(offset, offset + this.hop));
      if (q !== null) moved = q;
      offset += this.hop;
    }
    this.pending = buffer.slice(offset);
    return moved;
  }

  private processChunk(chunk: Float32Array): number | null {
    this.takeChunks.push(chunk);
    const previous = this.previous;
    this.previous = chunk;
    // The stream zero-pads the first block and drops its frame.
    if (!previous) return null;
    const frame = this.frame;
    frame.set(previous.subarray(previous.length - (this.nFft - this.hop)));
    frame.set(chunk, this.nFft - this.hop);
    const index = this.frameTuning.length;

    // Chroma of this frame, tuning from this frame alone (the server's per-call processor).
    const S = powerSpectrum(frame, 0, this.nFft, this.S);
    const start = this.peakPitches.length;
    piptrackFrame(S, this.sampleRate, this.nFft, this.peakPitches, this.peakMags);
    const tuning = estimateTuning(this.peakPitches.slice(start), this.peakMags.slice(start));
    const chroma = new Float32Array(12);
    chromaFromPower(S, chromaFilterBank(this.sampleRate, this.nFft, tuning), chroma);
    this.framePeakStart.push(start);
    this.frameTuning.push(tuning);
    for (let c = 0; c < 12; c += 1) this.liveChroma.push(chroma[c]);
    const offline = bandStatsFromPower(S, this.nFft, this.sampleRate);
    this.offlineLow.push(offline.low);
    this.offlineRms.push(offline.rms);

    // Live gate (its own window rounding, as the server's stream computes it), then the follower.
    const { low, rms } = bandStats(frame, 0, this.nFft, this.sampleRate);
    let moved: number | null = null;
    for (const released of this.gate.push(index, chroma, 0, low, rms)) {
      if (this.completed) break;
      const used = this.follower.step(this.liveChroma, released * 12);
      if (!used) continue;
      const q = this.quarterOfFrame(this.follower.currentFrame);
      if (q !== this.lastQuarter) {
        this.lastQuarter = q;
        moved = q;
      }
      // The follower stops once past the last note's onset (is_still_following). On the server
      // the frame sitting exactly on it still reads as just before it -- its beat_map gives a
      // hair under the float32 onset -- so it takes one more frame; strictly past matches that.
      if (q > this.reference.lastOnsetQuarter + 1e-9) this.completed = true;
    }
    return moved;
  }

  // Exactly the audio that was analysed (the grader's timeline).
  takeAudio(): Float32Array {
    const out = new Float32Array(this.takeChunks.length * this.hop);
    this.takeChunks.forEach((c, i) => out.set(c, i * this.hop));
    return out;
  }

  // The post-take alignment: (seconds on the take's timeline, quarter) pairs.
  finish(): AlignmentPathPoint[] {
    const frames = this.frameTuning.length;
    if (frames < 2) return [];
    const take = this.takeAudio();
    // One tuning for the whole take, from every frame's peaks (as librosa does over the full
    // spectrogram); frames analysed live at that same tuning already have the right chroma.
    const tuning = estimateTuning(this.peakPitches, this.peakMags);
    const bank = chromaFilterBank(this.sampleRate, this.nFft, tuning);
    const features = Float32Array.from(this.liveChroma);
    for (let t = 0; t < frames; t += 1) {
      if (this.frameTuning[t] === tuning) continue;
      const S = powerSpectrum(take, t * this.hop, this.nFft, this.S);
      chromaFromPower(S, bank, features, t * 12);
    }
    const gate = new PlayingGate<number>();
    const tonal: number[] = [];
    for (let t = 0; t < frames; t += 1) tonal.push(...gate.push(t, features, t * 12, this.offlineLow[t], this.offlineRms[t]));
    return alignFromFeatures(
      {
        take,
        sampleRate: this.sampleRate,
        hop: this.hop,
        nFft: this.nFft,
        reference: this.reference.chroma,
        refFrameQuarter: this.reference.frameQuarter,
        seeks: this.seeks,
        liveFinal: this.follower.currentFrame
      },
      features,
      frames,
      tonal
    );
  }
}
