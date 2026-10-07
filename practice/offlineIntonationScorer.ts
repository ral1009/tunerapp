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
  const starts = entries.map((entry) => timeAtQuarter(path, entry.quarter));
  for (let i = 0; i < entries.length; i += 1) {
    const { stepIndex, quarter } = entries[i];
    const note = notes[stepIndex];
    if (!note || note.primaryFrequencyHz === null) continue;
    // The note sounds until the next note starts, or until its own written length ends if a rest
    // follows -- the rest is silence, not this note.
    const nextQuarter = i + 1 < entries.length ? entries[i + 1].quarter : Number.POSITIVE_INFINITY;
    const startSeconds = starts[i];
    if (startSeconds === null) continue; // never reached: stays not_played
    const restFollows = quarter + note.durationQuarterNotes < nextQuarter - 1e-6;
    const endSeconds = restFollows || i + 1 >= entries.length || starts[i + 1] === null
      ? timeAtQuarter(path, Math.min(nextQuarter, quarter + note.durationQuarterNotes)) ?? path[path.length - 1].perfTimeSeconds
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
