// Finding the place again when the live follower has lost it.
//
// The Arzt follower (arztFollower.ts) only moves forward, at most 3 reference frames per input
// frame, inside a window around where it already is. That is right while it's on track and makes
// it stable, but it means it can't come back once lost: a player who restarts a phrase or the
// piece, starts partway in, or skips a bar leaves it waiting (or crawling) far from where the
// music is -- "following stopped" on a phone. Measured with `npm run alignStressTest`: restarting
// from the top never recovered on any take; going back 5 s didn't on 3 of 5; starting at 30% of
// the Giga never did.
//
// This keeps the last few seconds of played (tonal, gate-accepted) frames and, every few frames,
// matches them against the WHOLE reference with open-begin, open-end DTW (each played frame used
// once; the reference may stay or advance 1 or 2 frames per played frame, so the player can be up
// to 2x the score's tempo and arbitrarily slower). If the best place is away from where the
// follower is, is clearly better than anything near the follower, isn't one of several equally
// good places (repeated passages), and the next check agrees, the follower should move there.
//
// Distances are the follower's own L1 between chroma vectors, at half the frame rate: pairs of
// played frames and pairs of reference frames are averaged (4x less matching work; the follower
// places itself to the frame after a move). A row of distances to every reference pair is
// computed once per pair played and kept for the length of the window.
const DECIMATE = 2;

// The window matched: a short one, and a long one for when the short one fits several places
// (Twinkle's lines 2 and 3 are the same notes; its line 4 is line 1 -- only a window reaching
// across a line boundary tells them apart).
const DEBUG = typeof process !== "undefined" && !!process.env?.PLACE_DEBUG;
export const PLACE_WINDOW_SECONDS = 3;
export const PLACE_LONG_WINDOW_SECONDS = 8;
// Checks in a row that must agree before moving: about a second, so a window that straddles the
// moment the player jumped (old place, then new place -- a sequence that can exist elsewhere in
// the score) has mostly moved past it.
export const PLACE_CONFIRMATIONS = 3;
// The match may begin partway into the window (the player jumped inside it); every played frame
// it leaves out costs this many times the follower's own typical per-frame distance over the
// last ~10 s, within [PLACE_SKIP_MIN, PLACE_SKIP_MAX]. Measured on real takes: a frame on the
// right place costs ~0.3 (simple pieces) to ~1.2 (the Giga's chords and fast runs), a frame at
// a random place ~2.8 -- skipping must cost more than the first and less than the second.
export const PLACE_SKIP_FACTOR = 2;
export const PLACE_SKIP_MIN = 1.0;
export const PLACE_SKIP_MAX = 2.5;
const ON_TRACK_HISTORY = 300;
// ...and must still cover this much playing to count.
export const PLACE_MIN_MATCH_SECONDS = 1.5;
export const PLACE_CHECK_EVERY_FRAMES = 10;
// Away: further than this from the follower (reference seconds).
export const PLACE_AWAY_SECONDS = 1.5;
// The best place must cost at most this fraction of the best near the follower...
export const PLACE_BETTER_RATIO = 0.8;
// ...and the next best place elsewhere must cost at least this much more than it.
export const PLACE_UNIQUE_RATIO = 1.1;

export interface PlaceFound {
  target: number; // reference frame the follower should be on now
  startTakeFrame: number; // take frame where the matched stretch of playing began
  startRefFrame: number; // reference frame it began at
}

// near: the best place is where the follower is. weak: elsewhere, but not clearly better.
type Verdict = { kind: "near" } | { kind: "weak" } | { kind: "ambiguous" } | { kind: "lost"; found: PlaceFound };

export class PlaceFinder {
  private readonly reference: Float32Array;
  private readonly nRef: number;
  private readonly shortWindow: number;
  private readonly longWindow: number;
  private readonly away: number;
  // Ring of distance rows (longWindow x nRef) and the take frame each row came from.
  private readonly rows: Float32Array;
  private readonly takeFrames: Int32Array;
  private count = 0; // rows filled (<= longWindow)
  private head = 0; // next row to write
  private sinceCheck = 0;
  private agreed: PlaceFound[] = [];
  // DP scratch: cost and start column for the previous and current played frame.
  private readonly costA: Float32Array;
  private readonly costB: Float32Array;
  private readonly startA: Int32Array;
  private readonly startB: Int32Array;
  private readonly rowA: Int32Array;
  private readonly rowB: Int32Array;
  private onTrack: number[] = []; // the follower's own distance, per played frame (recent)
  private readonly minMatch: number;

  private readonly fullReference: Float32Array;
  private readonly pair = new Float32Array(12);
  private pairCount = 0;
  private pairFirstFrame = 0;

  constructor(reference: Float32Array, frameRate: number) {
    this.fullReference = reference;
    const nFull = reference.length / 12;
    this.nRef = Math.ceil(nFull / DECIMATE);
    this.reference = new Float32Array(this.nRef * 12);
    for (let j = 0; j < nFull; j += 1) for (let c = 0; c < 12; c += 1) this.reference[Math.floor(j / DECIMATE) * 12 + c] += reference[j * 12 + c];
    for (let j = 0; j < this.nRef; j += 1) {
      const count = Math.min(DECIMATE, nFull - j * DECIMATE);
      for (let c = 0; c < 12; c += 1) this.reference[j * 12 + c] /= count;
    }
    const rate = frameRate / DECIMATE;
    this.shortWindow = Math.round(PLACE_WINDOW_SECONDS * rate);
    this.longWindow = Math.round(PLACE_LONG_WINDOW_SECONDS * rate);
    this.away = Math.round(PLACE_AWAY_SECONDS * rate);
    this.rows = new Float32Array(this.longWindow * this.nRef);
    this.takeFrames = new Int32Array(this.longWindow);
    this.costA = new Float32Array(this.nRef);
    this.costB = new Float32Array(this.nRef);
    this.startA = new Int32Array(this.nRef);
    this.startB = new Int32Array(this.nRef);
    this.rowA = new Int32Array(this.nRef);
    this.rowB = new Int32Array(this.nRef);
    this.minMatch = Math.round(PLACE_MIN_MATCH_SECONDS * rate);
  }

  // Forget the window (after a jump: what came before is another place).
  reset(): void {
    this.count = 0;
    this.head = 0;
    this.sinceCheck = 0;
    this.agreed = [];
    this.pairCount = 0;
  }

  // One played frame (the chroma the follower just used).
  push(chroma: ArrayLike<number>, offset: number, takeFrame: number, followerFrame: number): void {
    // The follower's own distance for this frame, in a ±1 frame tolerance.
    const full = this.fullReference;
    const nFull = full.length / 12;
    let own = Infinity;
    for (let j = Math.max(0, followerFrame - 1); j <= Math.min(nFull - 1, followerFrame + 1); j += 1) {
      let d = 0;
      for (let c = 0; c < 12; c += 1) d += Math.abs(full[j * 12 + c] - chroma[offset + c]);
      own = Math.min(own, d);
    }
    this.onTrack.push(own);
    if (this.onTrack.length > ON_TRACK_HISTORY) this.onTrack.shift();

    // Pairs of played frames, averaged.
    if (this.pairCount === 0) {
      this.pairFirstFrame = takeFrame;
      for (let c = 0; c < 12; c += 1) this.pair[c] = chroma[offset + c];
    } else {
      for (let c = 0; c < 12; c += 1) this.pair[c] += chroma[offset + c];
    }
    this.pairCount += 1;
    if (this.pairCount < DECIMATE) return;
    this.pairCount = 0;
    for (let c = 0; c < 12; c += 1) this.pair[c] /= DECIMATE;

    const row = this.head * this.nRef;
    const ref = this.reference;
    for (let j = 0; j < this.nRef; j += 1) {
      const r = j * 12;
      let d = 0;
      for (let c = 0; c < 12; c += 1) d += Math.abs(ref[r + c] - this.pair[c]);
      this.rows[row + j] = d;
    }
    this.takeFrames[this.head] = this.pairFirstFrame;
    this.head = (this.head + 1) % this.longWindow;
    if (this.count < this.longWindow) this.count += 1;
    this.sinceCheck += 1;
  }

  // Open-begin, open-end DTW of the newest `len` played frames against the whole reference.
  private judge(len: number, current: number): Verdict {
    const n = this.nRef;
    const L = this.longWindow;
    let prev = this.costA;
    let next = this.costB;
    let prevStart = this.startA;
    let nextStart = this.startB;
    let prevRow = this.rowA;
    let nextRow = this.rowB;
    const first = (this.head - len + L) % L; // oldest row used
    const sorted = [...this.onTrack].sort((x, y) => x - y);
    const skip = Math.min(PLACE_SKIP_MAX, Math.max(PLACE_SKIP_MIN, PLACE_SKIP_FACTOR * sorted[sorted.length >> 1]));
    for (let j = 0; j < n; j += 1) {
      prev[j] = this.rows[first * n + j];
      prevStart[j] = j;
      prevRow[j] = 0;
    }
    for (let i = 1; i < len; i += 1) {
      const row = ((first + i) % L) * n;
      const fresh = skip * i; // leave out the i frames before this one
      for (let j = 0; j < n; j += 1) {
        let best = fresh;
        let start = j;
        let startRow = i;
        if (prev[j] < best) {
          best = prev[j];
          start = prevStart[j];
          startRow = prevRow[j];
        }
        if (j >= 1 && prev[j - 1] < best) {
          best = prev[j - 1];
          start = prevStart[j - 1];
          startRow = prevRow[j - 1];
        }
        if (j >= 2 && prev[j - 2] < best) {
          best = prev[j - 2];
          start = prevStart[j - 2];
          startRow = prevRow[j - 2];
        }
        next[j] = best + this.rows[row + j];
        nextStart[j] = start;
        nextRow[j] = startRow;
      }
      [prev, next] = [next, prev];
      [prevStart, nextStart] = [nextStart, prevStart];
      [prevRow, nextRow] = [nextRow, prevRow];
    }
    // prev: the cost of the best match ending at each reference frame.
    let bestJ = 0;
    for (let j = 1; j < n; j += 1) if (prev[j] < prev[bestJ]) bestJ = j;
    let near = Infinity;
    for (let j = Math.max(0, current - this.away); j <= Math.min(n - 1, current + this.away); j += 1) near = Math.min(near, prev[j]);
    if (DEBUG) {
      const lo2 = prevStart[bestJ] - this.away;
      let other2 = Infinity;
      for (let j = 0; j < n; j += 1) if (j < lo2 || j > bestJ + this.away) other2 = Math.min(other2, prev[j]);
      console.log(`    [place] len ${len} cur ${current} best ${bestJ} (from ${prevStart[bestJ]}, row ${prevRow[bestJ]}) cost ${prev[bestJ].toFixed(1)} near ${near.toFixed(1)} other ${other2.toFixed(1)} skip ${skip.toFixed(2)}`);
    }
    if (Math.abs(bestJ - current) <= this.away) return { kind: "near" };
    if (!(prev[bestJ] <= PLACE_BETTER_RATIO * near)) return { kind: "weak" };
    // Unique: nothing comparable outside the stretch this match covers.
    const lo = prevStart[bestJ] - this.away;
    const hi = bestJ + this.away;
    let other = Infinity;
    for (let j = 0; j < n; j += 1) if (j < lo || j > hi) other = Math.min(other, prev[j]);
    if (!(other >= PLACE_UNIQUE_RATIO * prev[bestJ])) return { kind: "ambiguous" };
    if (len - prevRow[bestJ] < this.minMatch) return { kind: "weak" };
    return { kind: "lost", found: { target: bestJ, startTakeFrame: this.takeFrames[(first + prevRow[bestJ]) % L], startRefFrame: prevStart[bestJ] } };
  }

  // Where the follower should be, if it's lost; null if it's fine (or it can't be told yet).
  check(currentFrame: number): PlaceFound | null {
    if (this.count < this.shortWindow || this.sinceCheck < PLACE_CHECK_EVERY_FRAMES / DECIMATE) return null;
    this.sinceCheck = 0;
    const current = Math.floor(currentFrame / DECIMATE);
    let verdict = this.judge(this.shortWindow, current);
    if ((verdict.kind === "ambiguous" || verdict.kind === "weak") && this.count >= this.longWindow) verdict = this.judge(this.longWindow, current);
    if (verdict.kind !== "lost") {
      this.agreed = [];
      return null;
    }
    const found = verdict.found;
    // Agrees with the last check: the same place, moved on by at most what was played since.
    const last = this.agreed[this.agreed.length - 1];
    if (last && !(found.target >= last.target - 2 && found.target <= last.target + PLACE_CHECK_EVERY_FRAMES + 2)) this.agreed = [];
    this.agreed.push(found);
    if (this.agreed.length < PLACE_CONFIRMATIONS) return null;
    // The stretch began where the first agreeing check saw it begin. Back to full frames: the
    // end of the matched pair, the start of the first.
    const nFull = this.fullReference.length / 12;
    const result = {
      target: Math.min(nFull - 1, found.target * DECIMATE + DECIMATE - 1),
      startTakeFrame: this.agreed[0].startTakeFrame,
      startRefFrame: Math.min(nFull - 1, this.agreed[0].startRefFrame * DECIMATE),
    };
    this.agreed = [];
    return result;
  }
}
