// The live score follower: matchmaker's OnlineTimeWarpingArztFrame.step + its Cython
// oltw_arzt_loop, with the server's _GatedArztFollower on top (non-tonal frames ignored; seek
// restarts the path at a reference frame). Arithmetic is float32 like the Cython (cost matrix,
// L1 distances, sums), so the path picks the same frame on near ties.
import { isTonalFrame } from "./playingGate";

const fround = Math.fround;

// matchmaker DEFAULT_KWARGS["audio"]["arzt"]: window 10 s, start window 0.1 s, step 3 frames.
export const ARZT_WINDOW_SECONDS = 10;
export const ARZT_START_WINDOW_SECONDS = 0.1;
export const ARZT_STEP_SIZE = 3;

export class ArztFollower {
  readonly nRef: number;
  currentFrame = 0;
  inputIndex = 0;
  accepted = 0;
  rejected = 0;
  private readonly reference: Float32Array; // nRef x 12
  private readonly windowSize: number;
  private readonly startWindowSize: number;
  // (nRef + 1) x 2, column-major pairs: [i*2] = previous input, [i*2 + 1] = current input
  private readonly cost: Float32Array;
  private pendingSeek: number | null = null;
  stepSize: number; // may be changed between steps (deviceAligner.ts raises it for fast players)
  private readonly local: Float32Array; // per-step distances, reused (sized for the widest window)

  // stepSize: the most reference frames it may move per played frame (matchmaker: 3).
  constructor(reference: Float32Array, frameRate: number, stepSize = ARZT_STEP_SIZE) {
    this.stepSize = stepSize;
    this.reference = reference;
    this.nRef = reference.length / 12;
    this.windowSize = Math.round(ARZT_WINDOW_SECONDS * frameRate);
    this.startWindowSize = Math.round(ARZT_START_WINDOW_SECONDS * frameRate);
    this.cost = new Float32Array((this.nRef + 1) * 2).fill(Infinity);
    this.local = new Float32Array(Math.min(this.nRef, 2 * Math.max(this.windowSize, this.startWindowSize) + 1));
  }

  // Applied before the next frame, like the server (the seek arrives between frames).
  seek(frame: number): void {
    this.pendingSeek = Math.min(Math.max(frame, 0), this.nRef - 1);
  }

  // One live chroma frame. Returns true if it was used (tonal), false if ignored.
  step(chroma: ArrayLike<number>, offset = 0): boolean {
    if (this.pendingSeek !== null) {
      this.cost.fill(Infinity);
      this.cost[(this.pendingSeek + 1) * 2] = 0;
      this.currentFrame = this.pendingSeek;
      this.pendingSeek = null;
    }
    if (!isTonalFrame(chroma, offset)) {
      this.rejected += 1;
      return false;
    }
    this.accepted += 1;

    const w = this.currentFrame < this.startWindowSize ? this.startWindowSize : this.windowSize;
    const windowStart = Math.max(this.currentFrame - w, 0);
    const windowEnd = Math.min(this.currentFrame + w, this.nRef);
    const cost = this.cost;
    const input = this.inputIndex;

    let minCosts = Infinity;
    let minIndex = Math.max(this.currentFrame - this.stepSize, 0);
    const local = this.local;
    for (let s = windowStart; s < windowEnd; s += 1) {
      let d = 0;
      const row = s * 12;
      for (let c = 0; c < 12; c += 1) d = fround(d + Math.abs(fround(this.reference[row + c] - chroma[offset + c])));
      local[s - windowStart] = d;
    }
    if (windowStart === 0 && input === 0) {
      let sum = 0;
      for (let i = 0; i < windowEnd - windowStart; i += 1) sum = fround(sum + local[i]);
      cost[1 * 2 + 1] = sum;
      minCosts = cost[1 * 2 + 1];
      minIndex = 0;
    }
    for (let s = windowStart; s < windowEnd; s += 1) {
      if (s === 0 && input === 0) continue;
      const ld = local[s - windowStart];
      const d1 = fround(cost[s * 2 + 1] + ld);
      const d2 = fround(cost[(s + 1) * 2] + ld);
      const d3 = fround(cost[s * 2] + ld);
      const best = Math.min(d1, d2, d3);
      cost[(s + 1) * 2 + 1] = best;
      const norm = fround(best / (input + s + 1.0));
      if (norm < minCosts) {
        minCosts = norm;
        minIndex = s;
      }
    }
    // update_cost_matrix: shift the current column into "previous", clear the current one.
    for (let i = 0; i < cost.length; i += 2) {
      cost[i] = cost[i + 1];
      cost[i + 1] = Infinity;
    }
    this.currentFrame = input > 0 ? Math.min(Math.max(minIndex, this.currentFrame), this.currentFrame + this.stepSize) : minIndex;
    this.inputIndex += 1;
    return true;
  }
}
