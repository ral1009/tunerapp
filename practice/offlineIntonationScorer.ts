import type { CursorNoteInfo, QuarterIndexEntry } from "../score/renderer/scoreCursor";
import { PitchDetector } from "../audio/pitchDetector";
import { centsOff, createEmptyRecord, isPlausibleReading, median, type NoteAccuracyRecord, type NoteVerdict } from "./cursor";
import { measureScoreInformedPitch } from "./scoreInformedPitch";

// Post-practice intonation grading for Matchmaker mode.
//
// Live grading has to decide which note a pitch reading belongs to while the live tracker is
// still unsure where the player is -- hence the jitter smoothing and settle timers in
// MatchmakerScoreFollower. Once the take is over, the server globally aligns the whole recording
// against the score (server/matchmaker_service.py's compute_offline_alignment), which pins down
// which stretch of audio belongs to which note far more tightly. This re-runs the same pitch
// detector the live tuner uses over the same recording and buckets readings by that alignment.
//
// Pure function over plain data -- no OSMD, no DOM -- so it runs under the Node harness
// (practice/__tests__/offline-scorer-harness.ts) as well as in the browser.

export interface AlignmentPoint {
  // Seconds on the recording's own timeline (only the audio that was sent; gated-out pauses are
  // not in it), at the centre of the analysis window -- the same convention used below.
  perfTimeSeconds: number;
  quarter: number;
}

// Mirrors how the live capture module configures and feeds its detector
// (audio/captureModule/index.ts), so offline and live readings come from the same setup.
export interface OfflineDetectorSetup {
  sampleRate: number;
  // The live pipeline multiplies raw samples by this calibrated gain before detection; the
  // recording is the raw, ungained signal.
  gainScalar: number;
  // Raw (ungained) calibrated noise floor; the detector sees it scaled by gainScalar, as live.
  silenceRmsThreshold: number;
  frameSize: number;
  hopSize: number;
  confidenceThreshold: number;
  lowCutHz: number;
  highCutHz: number;
  smoothingWindowFrames: number;
}

export interface OfflineScoringConfig {
  inTuneCentsThreshold: number;
  minSamplesForVerdict: number;
  // Samples within this long after a note's aligned start are skipped: bowed attacks are messy.
  // Same intent as the live onsetSettleMs, but measured from where the note actually began.
  settleMs: number;
  plausibilityHighConfidenceThreshold: number;
  plausibilityLowConfidenceCentsLimit: number;
  plausibilityAbsoluteCentsLimit: number;
  // "score_informed" (default): one measurement per note over its whole aligned span, searching
  // only near the written pitch (practice/scoreInformedPitch.ts). Reads notes the frame detector
  // can't -- fast passages where the previous note or an open string is still ringing.
  // "frame_detector": the live tuner's detector run over short frames, median per note. Kept for
  // comparison in the replay harness.
  method?: "score_informed" | "frame_detector";
}

// The post-take alignment is accurate to about one 33 ms frame, so the last few ms of a note's
// aligned span may already belong to the next note.
const SPAN_END_GUARD_SECONDS = 0.015;

// How densely the recording is analyzed. The live tuner analyzes every 512 samples (~11 ms) for
// low latency; grading doesn't need that -- each note is summarized by the median of its readings.
// Re-running the detector at live density costs ~0.7x the take's own length (7 ms per 4096-sample
// frame, measured in Node; slower in a browser), so a one-minute take would take most of a minute
// to score. 20 ms spacing is ~2x cheaper than that while still leaving a sixteenth note at
// 120 bpm about four readings after the settle window.
export const OFFLINE_ANALYSIS_INTERVAL_SECONDS = 0.02;

// The detector's own rolling median (live default 5 frames) is turned off offline. At 20 ms
// spacing five frames span ~100 ms, which would smear one note's readings into the next across
// every boundary; the per-note median below already does the outlier rejection that smoother is
// for. Measured on the harness fixtures: grades unchanged to within 0.3 cents.
export const OFFLINE_SMOOTHING_FRAMES = 1;

// Same frame-size rule the capture module applies (captureModule/index.ts): larger windows at
// higher sample rates keep the lowest violin notes resolvable.
export function analysisFrameSizeFor(sampleRate: number, configuredFrameSize: number): number {
  return Math.max(configuredFrameSize, sampleRate >= 48_000 ? 4096 : 2048);
}

export function verdictFor(samples: number[], config: Pick<OfflineScoringConfig, "inTuneCentsThreshold" | "minSamplesForVerdict">): {
  averageCentsOff: number | null;
  verdict: NoteVerdict;
} {
  const averageCentsOff = median(samples);
  const verdict: NoteVerdict =
    samples.length < config.minSamplesForVerdict
      ? "not_played"
      : Math.abs(averageCentsOff ?? 0) <= config.inTuneCentsThreshold
        ? "in_tune"
        : "out_of_tune";
  return { averageCentsOff, verdict };
}

// ~20 frames is ~150 ms of detector work between yields -- short enough that the page stays usable.
const YIELD_EVERY_FRAMES = 20;

// See the selection step in scoreRecordingOffline.
export const MAX_READINGS_PER_NOTE = 12;

// Not setTimeout(0): browsers clamp timers in a background tab to about one per second, so a user
// who switches tabs while their take is being scored would stretch a sub-second job past the
// app's fallback timeout. A MessageChannel message is still a macrotask (the page gets to paint
// and handle input) but isn't subject to that clamp. Falls back to setTimeout where
// MessageChannel doesn't exist.
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export async function scoreRecordingOffline(
  recordedAudio: Float32Array,
  alignmentPath: readonly AlignmentPoint[],
  notes: readonly CursorNoteInfo[],
  quarterIndex: readonly QuarterIndexEntry[],
  detectorSetup: OfflineDetectorSetup,
  config: OfflineScoringConfig,
  onProgress?: (fraction: number) => void
): Promise<NoteAccuracyRecord[]> {
  const path = collapsePath(alignmentPath);
  if (path.length < 2 || notes.length === 0 || quarterIndex.length === 0) {
    return [];
  }

  const records = notes.map((note) => createEmptyRecord(note));
  if ((config.method ?? "score_informed") === "score_informed") {
    return scoreInformed(recordedAudio, path, notes, quarterIndex, detectorSetup, config, records, onProgress);
  }
  const { frameSize, hopSize, sampleRate, gainScalar } = detectorSetup;

  // Pass 1, cheap: decide which analysis frames belong to which note, before running the detector
  // on any of them. Frames outside the aligned span, or inside a note's settle window, never
  // reach the detector at all.
  const candidatesByNote = new Map<number, number[]>();
  const noteStartSeconds = new Map<number, number>();
  for (let start = 0; start + frameSize <= recordedAudio.length; start += hopSize) {
    const timeSeconds = (start + frameSize / 2) / sampleRate;
    const quarter = quarterAt(path, timeSeconds);
    if (quarter === null) {
      continue;
    }
    const stepIndex = stepIndexAt(quarterIndex, quarter);
    if (!notes[stepIndex]) {
      continue;
    }
    if (!noteStartSeconds.has(stepIndex)) {
      noteStartSeconds.set(stepIndex, timeSeconds);
    }
    if ((timeSeconds - (noteStartSeconds.get(stepIndex) ?? timeSeconds)) * 1000 < config.settleMs) {
      continue;
    }
    const list = candidatesByNote.get(stepIndex) ?? [];
    list.push(start);
    candidatesByNote.set(stepIndex, list);
  }

  // Detector work is the entire cost of this function (~7 ms per 4096-sample frame), so each note
  // is read at most MAX_READINGS_PER_NOTE times, evenly across its settled span. A median over a
  // dozen readings is already stable; a two-second whole note doesn't need a hundred. Short notes
  // keep every frame they have.
  const selected: Array<{ start: number; stepIndex: number }> = [];
  for (const [stepIndex, starts] of candidatesByNote) {
    const take = Math.min(starts.length, MAX_READINGS_PER_NOTE);
    for (let k = 0; k < take; k += 1) {
      const pick = take === starts.length ? k : Math.round((k * (starts.length - 1)) / (take - 1 || 1));
      selected.push({ start: starts[pick], stepIndex });
    }
  }
  selected.sort((a, b) => a.start - b.start);

  // Pass 2: the detector, configured like the live one. Readings are independent (see
  // OFFLINE_SMOOTHING_FRAMES), so analyzing a subset of frames is sound.
  const detector = new PitchDetector({
    preprocess: {
      sampleRate: detectorSetup.sampleRate,
      silenceRmsThreshold: detectorSetup.silenceRmsThreshold * detectorSetup.gainScalar,
      lowCutHz: detectorSetup.lowCutHz,
      highCutHz: detectorSetup.highCutHz
    },
    confidenceThreshold: detectorSetup.confidenceThreshold,
    smoothingWindowFrames: detectorSetup.smoothingWindowFrames
  });
  const frame = new Float32Array(frameSize);

  for (let index = 0; index < selected.length; index += 1) {
    const { start, stepIndex } = selected[index];
    const note = notes[stepIndex];
    for (let i = 0; i < frameSize; i += 1) {
      frame[i] = recordedAudio[start + i] * gainScalar;
    }
    // The alignment, not the pitch, decided which note this frame belongs to, so the search can be
    // narrowed to the written pitch (+-expectedNoteWindowSemitones). Without it, a fast passage's
    // readings were mostly another pitch entirely -- the previous note still ringing, a sympathetic
    // open string, or an octave slip -- and those notes came back "not played". Live tracking
    // deliberately does NOT do this (CLAUDE.md: it would hide evidence that the position is wrong);
    // here the position is settled before any reading is taken. A note played more than the window
    // away is still reported, as not played rather than as a cents figure.
    const reading = detector.detect({ samples: frame, expectedFrequencyHz: note.primaryFrequencyHz ?? undefined });

    if ((index + 1) % YIELD_EVERY_FRAMES === 0) {
      // Keeps the page responsive (and the progress readout paintable) over a long take.
      onProgress?.(index / selected.length);
      await yieldToEventLoop();
    }

    if (
      reading.frequencyHz === null ||
      note.primaryFrequencyHz === null ||
      !isPlausibleReading(
        reading.frequencyHz,
        reading.confidence,
        note.primaryFrequencyHz,
        config.plausibilityHighConfidenceThreshold,
        config.plausibilityLowConfidenceCentsLimit,
        config.plausibilityAbsoluteCentsLimit
      )
    ) {
      continue;
    }
    records[stepIndex].centsOffSamples.push(centsOff(reading.frequencyHz, note.primaryFrequencyHz));
  }
  onProgress?.(1);

  for (const record of records) {
    Object.assign(record, verdictFor(record.centsOffSamples, config));
    if (record.verdict === "not_played" && noteStartSeconds.has(record.stepIndex)) {
      record.verdict = "unmeasured";
    }
  }
  return records;
}

async function scoreInformed(
  recordedAudio: Float32Array,
  path: AlignmentPoint[],
  notes: readonly CursorNoteInfo[],
  quarterIndex: readonly QuarterIndexEntry[],
  detectorSetup: OfflineDetectorSetup,
  config: OfflineScoringConfig,
  records: NoteAccuracyRecord[],
  onProgress?: (fraction: number) => void
): Promise<NoteAccuracyRecord[]> {
  const { sampleRate, gainScalar } = detectorSetup;
  const entries = [...quarterIndex].sort((a, b) => a.quarter - b.quarter);
  // Note starts come straight from the alignment. Snapping them to nearby loudness rises (bow
  // attacks) was tried to fix repeated-note boundaries and made fast real passages much worse:
  // string crossings make loudness jumps that aren't note starts (Giga: 12% -> 36% of notes
  // unmeasured). Don't re-add it without note-level segmentation that checks the rhythm.
  // A take with jumps in it ("Jump to bar") is several stretches; each note is measured in the
  // LAST stretch that reached it, so a bar played again after jumping back is graded on the
  // second attempt.
  const stretches = splitAtBackwardJumps(path);
  const stretchFor = entries.map((entry) => {
    for (let k = stretches.length - 1; k >= 0; k -= 1) {
      if (reachedAt(stretches[k], entry.quarter) !== null) return stretches[k];
    }
    return null;
  });
  const starts = entries.map((entry, i) => (stretchFor[i] ? reachedAt(stretchFor[i] as AlignmentPoint[], entry.quarter) : null));
  splitRepeatedNoteRuns(recordedAudio, sampleRate, entries, notes, stretchFor, starts);
  for (let i = 0; i < entries.length; i += 1) {
    const { stepIndex, quarter } = entries[i];
    const note = notes[stepIndex];
    if (!note || note.primaryFrequencyHz === null) continue;
    // The note sounds until the next note starts, or until its own written length ends if a rest
    // follows -- the rest is silence, not this note.
    const nextQuarter = i + 1 < entries.length ? entries[i + 1].quarter : Number.POSITIVE_INFINITY;
    const startSeconds = starts[i];
    const stretch = stretchFor[i];
    if (startSeconds === null || stretch === null) continue; // never reached, or jumped over: stays not_played
    const restFollows = quarter + note.durationQuarterNotes < nextQuarter - 1e-6;
    const nextInSameStretch = i + 1 < entries.length && starts[i + 1] !== null && stretchFor[i + 1] === stretch;
    const endSeconds = restFollows || !nextInSameStretch
      ? timeAtQuarter(stretch, Math.min(nextQuarter, quarter + note.durationQuarterNotes)) ?? stretch[stretch.length - 1].perfTimeSeconds
      : (starts[i + 1] as number);

    // The settle window skips the bow attack. A whole-span measurement barely notices a brief
    // attack (harness section 5), so on a short note -- where a fixed 40 ms would leave almost
    // nothing to measure -- it shrinks to a fifth of the span.
    const settleSeconds = Math.min(config.settleMs / 1000, 0.2 * (endSeconds - startSeconds));
    const from = Math.round((startSeconds + settleSeconds) * sampleRate);
    const to = Math.min(recordedAudio.length, Math.round((endSeconds - SPAN_END_GUARD_SECONDS) * sampleRate));
    const record = records[stepIndex];
    if (to > from) {
      const segment = new Float32Array(to - from);
      for (let k = 0; k < segment.length; k += 1) segment[k] = recordedAudio[from + k] * gainScalar;
      const context = [entries[i - 1], entries[i + 1]]
        .map((entry) => (entry ? notes[entry.stepIndex]?.primaryFrequencyHz : null))
        .filter((hz): hz is number => typeof hz === "number");
      const reading = measureScoreInformedPitch(segment, sampleRate, note.primaryFrequencyHz, context);
      if (reading) record.centsOffSamples.push(reading.centsOff);
    }
    // One whole-span measurement per note, so a single reading is a verdict.
    Object.assign(record, verdictFor(record.centsOffSamples, { ...config, minSamplesForVerdict: 1 }));
    if (record.verdict === "not_played") record.verdict = "unmeasured";

    if ((i + 1) % YIELD_EVERY_FRAMES === 0) {
      onProgress?.(i / entries.length);
      await yieldToEventLoop();
    }
  }
  onProgress?.(1);
  return records;
}

// Repeated notes ("D D"): chroma has nothing to see at the boundary between two identical pitches,
// so the alignment's split inside such a run is arbitrary -- a badly-off first D could be
// measured on the second D's audio and graded fine (simulated beginners: one real mistake in four
// missed this way). The run's OUTER edges are reliable (the pitch changes there), so the inside
// is re-split by the written rhythm, then each split moves to the deepest loudness dip nearby (a
// bow change or re-articulation) if there is a clear one. Only inside same-pitch runs: snapping
// every note start to loudness changes was tried and made fast passages much worse, because
// string crossings make loudness jumps that aren't note starts.
const REPEAT_SPLIT_SEARCH_FRACTION = 0.35; // of the shorter neighbouring note, either side
const REPEAT_SPLIT_MAX_SEARCH_SECONDS = 0.15;
const REPEAT_SPLIT_DIP_RATIO = 0.7; // dip must fall below this fraction of both sides' peaks
const ENVELOPE_HOP_SECONDS = 0.005;

function splitRepeatedNoteRuns(
  audio: Float32Array,
  sampleRate: number,
  entries: readonly QuarterIndexEntry[],
  notes: readonly CursorNoteInfo[],
  stretchFor: ReadonlyArray<readonly AlignmentPoint[] | null>,
  starts: Array<number | null>
): void {
  const hzOf = (i: number) => notes[entries[i].stepIndex]?.primaryFrequencyHz ?? null;
  const endQuarterOf = (i: number) => entries[i].quarter + (notes[entries[i].stepIndex]?.durationQuarterNotes ?? 0);
  const joined = (i: number) =>
    i + 1 < entries.length &&
    starts[i] !== null &&
    starts[i + 1] !== null &&
    stretchFor[i] === stretchFor[i + 1] &&
    Math.abs(endQuarterOf(i) - entries[i + 1].quarter) < 1e-6;

  let i = 0;
  while (i < entries.length) {
    let j = i;
    const hz = hzOf(i);
    while (hz !== null && joined(j) && hzOf(j + 1) === hz) j += 1;
    if (j > i) {
      const stretch = stretchFor[i] as AlignmentPoint[];
      const runStart = starts[i] as number;
      const runEndQuarter = endQuarterOf(j);
      const runEnd = joined(j) ? (starts[j + 1] as number) : timeAtQuarter(stretch, runEndQuarter) ?? stretch[stretch.length - 1].perfTimeSeconds;
      const quarterSpan = runEndQuarter - entries[i].quarter;
      if (runEnd > runStart && quarterSpan > 0) {
        const secondsPerQuarter = (runEnd - runStart) / quarterSpan;
        for (let k = i + 1; k <= j; k += 1) {
          const byRhythm = runStart + (entries[k].quarter - entries[i].quarter) * secondsPerQuarter;
          const shorter = Math.min(entries[k].quarter - entries[k - 1].quarter, endQuarterOf(k) - entries[k].quarter) * secondsPerQuarter;
          const reach = Math.min(REPEAT_SPLIT_SEARCH_FRACTION * shorter, REPEAT_SPLIT_MAX_SEARCH_SECONDS);
          starts[k] = deepestDip(audio, sampleRate, byRhythm - reach, byRhythm + reach, starts[k - 1] as number, runEnd) ?? byRhythm;
        }
      }
    }
    i = j + 1;
  }
}

function rmsAt(audio: Float32Array, sampleRate: number, centreSeconds: number): number {
  const half = Math.round((ENVELOPE_HOP_SECONDS * sampleRate) / 2) * 2;
  const centre = Math.round(centreSeconds * sampleRate);
  let sum = 0;
  let count = 0;
  for (let n = Math.max(0, centre - half); n < Math.min(audio.length, centre + half); n += 1) {
    sum += audio[n] * audio[n];
    count += 1;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

// The time of the quietest point in [from, to] if it is a clear dip -- below DIP_RATIO of the
// loudest point on each side of it, looking out to `left` and `right` -- else null.
function deepestDip(audio: Float32Array, sampleRate: number, from: number, to: number, left: number, right: number): number | null {
  let best: number | null = null;
  let bestLevel = Infinity;
  for (let t = from; t <= to; t += ENVELOPE_HOP_SECONDS) {
    const level = rmsAt(audio, sampleRate, t);
    if (level < bestLevel) {
      bestLevel = level;
      best = t;
    }
  }
  if (best === null) return null;
  let peakBefore = 0;
  for (let t = left; t < best; t += ENVELOPE_HOP_SECONDS) peakBefore = Math.max(peakBefore, rmsAt(audio, sampleRate, t));
  let peakAfter = 0;
  for (let t = best; t <= right; t += ENVELOPE_HOP_SECONDS) peakAfter = Math.max(peakAfter, rmsAt(audio, sampleRate, t));
  return bestLevel < REPEAT_SPLIT_DIP_RATIO * Math.min(peakBefore, peakAfter) ? best : null;
}

// A step forward of more than this many quarter notes between two consecutive aligned frames
// (~33 ms apart) is a jump, not playing: nobody plays 30 quarter notes a second.
const JUMP_QUARTERS = 1;
// A step back of more than this is the player going back (a jump, or DTW's stretches meeting).
const BACKWARD_JUMP_QUARTERS = 0.5;

export function splitAtBackwardJumps(path: readonly AlignmentPoint[]): AlignmentPoint[][] {
  const stretches: AlignmentPoint[][] = [];
  let current: AlignmentPoint[] = [];
  let runningMax = -Infinity;
  for (const point of path) {
    if (current.length > 0 && point.quarter < runningMax - BACKWARD_JUMP_QUARTERS) {
      stretches.push(current);
      current = [];
      runningMax = -Infinity;
    }
    current.push(point);
    runningMax = Math.max(runningMax, point.quarter);
  }
  if (current.length > 0) stretches.push(current);
  return stretches;
}

// When this stretch reaches `quarter`, or null if it never does -- including when it jumps over
// it (a note skipped by "Jump to bar" was not played; interpolating across the jump would give
// it a few milliseconds of whatever was sounding and grade that).
export function reachedAt(stretch: readonly AlignmentPoint[], quarter: number): number | null {
  if (stretch.length === 0 || quarter < stretch[0].quarter - 1e-9) return null;
  let running = stretch[0].quarter;
  for (let i = 1; i < stretch.length; i += 1) {
    const q = Math.max(running, stretch[i].quarter);
    if (q >= quarter) {
      if (q - running > JUMP_QUARTERS && quarter > running + 1e-6 && quarter < q - 1e-6) return null;
      break;
    }
    running = q;
  }
  return timeAtQuarter(stretch, quarter);
}

// Inverse of quarterAt: when the aligned path reaches `quarter`, or null if it never does.
export function timeAtQuarter(path: readonly AlignmentPoint[], quarter: number): number | null {
  if (path.length === 0) return null;
  let running = -Infinity;
  for (let i = 0; i < path.length; i += 1) {
    const q = Math.max(running, path[i].quarter);
    if (q >= quarter) {
      if (i === 0) return quarter >= path[0].quarter - 1e-9 ? path[0].perfTimeSeconds : null;
      const prevQ = running;
      const prevT = path[i - 1].perfTimeSeconds;
      if (q === prevQ) return path[i].perfTimeSeconds;
      return prevT + ((quarter - prevQ) / (q - prevQ)) * (path[i].perfTimeSeconds - prevT);
    }
    running = q;
  }
  return null;
}

// DTW paths can repeat a time (several reference frames on one performance frame); keep the last
// quarter for each time so interpolation never divides by zero, and sort defensively.
function collapsePath(alignmentPath: readonly AlignmentPoint[]): AlignmentPoint[] {
  const sorted = [...alignmentPath].sort((a, b) => a.perfTimeSeconds - b.perfTimeSeconds);
  const collapsed: AlignmentPoint[] = [];
  for (const point of sorted) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.perfTimeSeconds === point.perfTimeSeconds) {
      collapsed[collapsed.length - 1] = point;
    } else {
      collapsed.push(point);
    }
  }
  return collapsed;
}

// Linear interpolation inside the aligned span; null outside it. Clamping instead would pile
// every frame of lead-in or trailing audio onto the first or last note.
export function quarterAt(path: readonly AlignmentPoint[], timeSeconds: number): number | null {
  if (path.length === 0 || timeSeconds < path[0].perfTimeSeconds || timeSeconds > path[path.length - 1].perfTimeSeconds) {
    return null;
  }
  let low = 0;
  let high = path.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (path[mid].perfTimeSeconds <= timeSeconds) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const a = path[low];
  const b = path[high];
  if (b.perfTimeSeconds === a.perfTimeSeconds) {
    return a.quarter;
  }
  const fraction = (timeSeconds - a.perfTimeSeconds) / (b.perfTimeSeconds - a.perfTimeSeconds);
  return a.quarter + fraction * (b.quarter - a.quarter);
}

// Same "last entry at or before" rule as ScoreCursor.seekToQuarter(): a position inside a rest or
// a tied continuation belongs to the note still sounding.
export function stepIndexAt(index: readonly QuarterIndexEntry[], quarter: number): number {
  let low = 0;
  let high = index.length - 1;
  let found = index[0].stepIndex;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index[mid].quarter <= quarter + 1e-9) {
      found = index[mid].stepIndex;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
