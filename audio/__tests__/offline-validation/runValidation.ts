import fs from "node:fs";
import path from "node:path";
import WavDecoder from "wav-decoder";
import { PitchDetector } from "../../pitchDetector";
import { OnsetDetector } from "../../onsetDetector";
import { applyBandPass } from "../../preprocessing";

interface ClipSpec {
  file: string;
  // Pitch-accuracy fields -- optional so a clip can be onset-only (a multi-note sequence has no
  // single "expected note" to check steady-state accuracy against).
  expectedNote?: string;
  expectedFrequencyHz?: number;
  steadyStartMs?: number;
  steadyEndMs?: number;
  restWindowsMs: Array<[number, number]>;
  // Onset ground truth: timestamp (ms from clip start) of every real note attack. Optional --
  // clips without this are excluded from onset scoring entirely.
  expectedOnsetsMs?: number[];
  // Marks a clip as informational-only for onset scoring (measured and printed, but excluded
  // from the pass/fail gate) -- for fixtures whose note spacing is below minOnsetIntervalMs,
  // where recall is mechanically capped by that debounce floor regardless of fluxThreshold.
  onsetDiagnosticOnly?: boolean;
}

interface ValidationSpec {
  sampleRate: number;
  frameSize: number;
  hopSize: number;
  clips: ClipSpec[];
}

interface FrameResult {
  ms: number;
  note: string | null;
  freq: number | null;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function frequencyToMidi(frequencyHz: number): number {
  return Math.round(69 + 12 * Math.log2(frequencyHz / 440));
}

function midiToNoteName(midi: number): string {
  const note = NOTE_NAMES[(midi % 12 + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function frequencyToNoteName(frequencyHz: number): string {
  return midiToNoteName(frequencyToMidi(frequencyHz));
}

function stableFrameResults(
  pcm: Float32Array,
  sampleRate: number,
  frameSize: number,
  hopSize: number,
  detector: PitchDetector,
  expectedFrequencyHz?: number
): FrameResult[] {
  const frames: FrameResult[] = [];
  for (let offset = 0; offset + frameSize <= pcm.length; offset += hopSize) {
    const frame = pcm.subarray(offset, offset + frameSize);
    const detection = detector.detect({ samples: frame, expectedFrequencyHz });
    const ms = (offset / sampleRate) * 1000;
    frames.push({
      ms,
      note: detection.frequencyHz ? frequencyToNoteName(detection.frequencyHz) : null,
      freq: detection.frequencyHz
    });
  }
  return frames;
}

function withinWindow(ms: number, start: number, end: number): boolean {
  return ms >= start && ms <= end;
}

function firstStableCorrectFrameMs(
  frames: FrameResult[],
  expectedNote: string,
  startMs: number,
  consecutiveFrames = 3
): number | null {
  let streak = 0;
  for (const frame of frames) {
    if (frame.ms < startMs) {
      continue;
    }
    if (frame.note === expectedNote) {
      streak += 1;
      if (streak >= consecutiveFrames) {
        return frame.ms;
      }
    } else {
      streak = 0;
    }
  }
  return null;
}

// Mirrors audio/captureModule/index.ts's ONSET_ANALYSIS_FRAME_SIZE / DEFAULT_LOW_CUT_HZ /
// DEFAULT_HIGH_CUT_HZ. Duplicated here (not imported) because those are module-private in
// captureModule -- if they ever change there, update these to match or this harness silently
// stops being representative of production onset-detection behavior.
const ONSET_WINDOW_SIZE = 1024;
const ONSET_LOW_CUT_HZ = 80;
const ONSET_HIGH_CUT_HZ = 3500;

interface OnsetEvent {
  ms: number;
  flux: number;
}

function collectOnsetEvents(
  pcm: Float32Array,
  sampleRate: number,
  frameSize: number,
  hopSize: number,
  onsetDetector: OnsetDetector
): OnsetEvent[] {
  if (frameSize < ONSET_WINDOW_SIZE) {
    throw new Error(`frameSize (${frameSize}) must be >= ONSET_WINDOW_SIZE (${ONSET_WINDOW_SIZE}) to mirror production onset windowing.`);
  }

  const events: OnsetEvent[] = [];
  for (let offset = 0; offset + frameSize <= pcm.length; offset += hopSize) {
    const frame = pcm.subarray(offset, offset + frameSize);
    // Onset detection runs on a band-passed tail window of the larger pitch-analysis frame, not
    // the whole frame, and is timestamped at the frame's START (not the end of the analyzed
    // tail) -- both quirks are real production behavior (captureModule/index.ts), mirrored here
    // rather than "fixed", so tuning conclusions actually transfer.
    const tail = frame.subarray(frame.length - ONSET_WINDOW_SIZE);
    const bandPassed = applyBandPass(tail, sampleRate, ONSET_LOW_CUT_HZ, ONSET_HIGH_CUT_HZ);
    const ms = (offset / sampleRate) * 1000;
    const { onset, flux } = onsetDetector.detect(bandPassed, ms);
    if (onset) {
      events.push({ ms, flux });
    }
  }
  return events;
}

interface OnsetScore {
  totalExpected: number;
  matchedExpected: number;
  falsePositives: number;
  restWindowFalsePositives: number;
}

// One-to-one greedy nearest-match rather than "any detected onset within range counts for every
// nearby expected onset" -- keeps counts honest as fixtures approach minOnsetIntervalMs spacing,
// where match windows for adjacent expected onsets can overlap. Tolerance is asymmetric: an
// EARLY_SLACK_MS-sized early allowance accounts for production labeling each frame at its
// START (frameSize/sampleRate ms before the analyzed tail window actually ends), plus extra
// late tolerance for the flux to ramp up over a few hops.
function scoreOnsets(
  detected: OnsetEvent[],
  expectedMs: number[],
  restWindowsMs: Array<[number, number]>,
  earlySlackMs: number,
  lateToleranceMs: number
): OnsetScore {
  const unmatched = detected.map((_, index) => index);
  let matchedExpected = 0;

  for (const expected of expectedMs) {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const index of unmatched) {
      const delta = detected[index].ms - expected;
      if (delta >= -earlySlackMs && delta <= lateToleranceMs && Math.abs(delta) < bestDelta) {
        bestDelta = Math.abs(delta);
        bestIndex = index;
      }
    }
    if (bestIndex !== -1) {
      matchedExpected += 1;
      unmatched.splice(unmatched.indexOf(bestIndex), 1);
    }
  }

  let falsePositives = 0;
  let restWindowFalsePositives = 0;
  for (const index of unmatched) {
    falsePositives += 1;
    if (restWindowsMs.some(([start, end]) => withinWindow(detected[index].ms, start, end))) {
      restWindowFalsePositives += 1;
    }
  }

  return {
    totalExpected: expectedMs.length,
    matchedExpected,
    falsePositives,
    restWindowFalsePositives
  };
}

function loadSpec(specPath: string): ValidationSpec {
  if (!fs.existsSync(specPath)) {
    throw new Error(`Missing ${specPath}. Copy ground-truth.example.json and fill real clip metadata.`);
  }

  return JSON.parse(fs.readFileSync(specPath, "utf8")) as ValidationSpec;
}

function readWavSampleRate(buffer: Buffer): number {
  if (buffer.length < 44) {
    throw new Error("WAV header is too short to contain fmt metadata.");
  }

  const riffHeader = buffer.toString("ascii", 0, 4);
  if (riffHeader !== "RIFF") {
    throw new Error("WAV file is missing the RIFF header.");
  }

  const fmtChunk = buffer.indexOf(Buffer.from("fmt ", "ascii"));
  if (fmtChunk === -1) {
    throw new Error("WAV file is missing the fmt chunk.");
  }

  const sampleRate = buffer.readUInt32LE(fmtChunk + 12);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("WAV file has an invalid sample rate in the fmt chunk.");
  }

  return sampleRate;
}

async function loadMonoWav(filePath: string): Promise<{ sampleRate: number; samples: Float32Array }> {
  const buffer = fs.readFileSync(filePath);
  const csvSampleRate = readWavSampleRate(buffer);
  const audioData = await WavDecoder.decode(buffer);
  if (audioData.channelData.length === 0) {
    throw new Error(`No channel data in ${filePath}`);
  }

  return {
    sampleRate: csvSampleRate,
    samples: audioData.channelData[0]
  };
}

function octaveDifference(noteA: string, noteB: string): number {
  const parse = (note: string): number => {
    const match = note.match(/^([A-G]#?)(-?\d+)$/);
    if (!match) {
      return Number.NaN;
    }
    const [_, name, octaveStr] = match;
    const octave = Number.parseInt(octaveStr, 10);
    const index = NOTE_NAMES.indexOf(name);
    return (octave + 1) * 12 + index;
  };

  const midiA = parse(noteA);
  const midiB = parse(noteB);
  if (!Number.isFinite(midiA) || !Number.isFinite(midiB)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.abs(Math.floor((midiA - midiB) / 12));
}

async function main(): Promise<void> {
  const root = __dirname;
  const specPath = path.join(root, "ground-truth.json");
  const spec = loadSpec(specPath);

  let totalSteadyFrames = 0;
  let correctSteadyFrames = 0;
  let octaveErrors = 0;
  let totalRestFrames = 0;
  let cleanRestFrames = 0;
  const onsetLatenciesMs: number[] = [];

  let gatingOnsetTotalExpected = 0;
  let gatingOnsetMatched = 0;
  let gatingOnsetFalsePositives = 0;
  let gatingOnsetRestFalsePositives = 0;
  let diagnosticOnsetTotalExpected = 0;
  let diagnosticOnsetMatched = 0;

  for (const clip of spec.clips) {
    const wavPath = path.resolve(root, clip.file);
    const wav = await loadMonoWav(wavPath);

    const detector = new PitchDetector({
      preprocess: {
        sampleRate: wav.sampleRate,
        silenceRmsThreshold: 0.02,
        lowCutHz: 80,
        highCutHz: 3500
      },
      confidenceThreshold: 0.4,
      smoothingWindowFrames: 5,
      expectedNoteWindowSemitones: 3
    });

    if (wav.sampleRate !== spec.sampleRate) {
      console.warn(`Sample rate mismatch for ${clip.file}: got ${wav.sampleRate}, metadata says ${spec.sampleRate}`);
    }

    // The bundled validation clips are 48kHz fixtures; this path will adapt to any header-defined rate automatically.

    const frames = stableFrameResults(
      wav.samples,
      wav.sampleRate,
      spec.frameSize,
      spec.hopSize,
      detector,
      clip.expectedFrequencyHz
    );

    const hasSteadyWindow = clip.expectedNote !== undefined && clip.steadyStartMs !== undefined && clip.steadyEndMs !== undefined;

    for (const frame of frames) {
      if (hasSteadyWindow && withinWindow(frame.ms, clip.steadyStartMs!, clip.steadyEndMs!)) {
        totalSteadyFrames += 1;
        if (frame.note === clip.expectedNote) {
          correctSteadyFrames += 1;
        }
        if (frame.note && octaveDifference(frame.note, clip.expectedNote!) >= 1 && frame.note !== clip.expectedNote) {
          octaveErrors += 1;
        }
      }

      for (const [start, end] of clip.restWindowsMs) {
        if (withinWindow(frame.ms, start, end)) {
          totalRestFrames += 1;
          if (!frame.note) {
            cleanRestFrames += 1;
          }
          break;
        }
      }
    }

    if (hasSteadyWindow) {
      const firstStableMs = firstStableCorrectFrameMs(frames, clip.expectedNote!, clip.steadyStartMs!);
      if (firstStableMs !== null) {
        onsetLatenciesMs.push(firstStableMs - clip.steadyStartMs!);
      }
    }

    if (clip.expectedOnsetsMs) {
      const onsetDetector = new OnsetDetector({ sampleRate: wav.sampleRate });
      const onsetEvents = collectOnsetEvents(wav.samples, wav.sampleRate, spec.frameSize, spec.hopSize, onsetDetector);
      const earlySlackMs = (spec.frameSize / wav.sampleRate) * 1000;
      const lateToleranceMs = earlySlackMs + 3 * (spec.hopSize / wav.sampleRate) * 1000;
      const score = scoreOnsets(onsetEvents, clip.expectedOnsetsMs, clip.restWindowsMs, earlySlackMs, lateToleranceMs);

      if (clip.onsetDiagnosticOnly) {
        diagnosticOnsetTotalExpected += score.totalExpected;
        diagnosticOnsetMatched += score.matchedExpected;
      } else {
        gatingOnsetTotalExpected += score.totalExpected;
        gatingOnsetMatched += score.matchedExpected;
        gatingOnsetFalsePositives += score.falsePositives;
        gatingOnsetRestFalsePositives += score.restWindowFalsePositives;
      }
    }
  }

  const steadyAccuracy = totalSteadyFrames > 0 ? correctSteadyFrames / totalSteadyFrames : 0;
  const restCleanRate = totalRestFrames > 0 ? cleanRestFrames / totalRestFrames : 0;
  const meanOnsetLatency =
    onsetLatenciesMs.length > 0
      ? onsetLatenciesMs.reduce((sum, value) => sum + value, 0) / onsetLatenciesMs.length
      : Number.POSITIVE_INFINITY;

  const passSteadyAccuracy = steadyAccuracy >= 0.95;
  const passOctaveErrors = octaveErrors <= 1;
  const passRestHandling = restCleanRate >= 0.99;
  const passLatency = meanOnsetLatency <= 150;

  const onsetRecall = gatingOnsetTotalExpected > 0 ? gatingOnsetMatched / gatingOnsetTotalExpected : 1;
  const diagnosticOnsetRecall = diagnosticOnsetTotalExpected > 0 ? diagnosticOnsetMatched / diagnosticOnsetTotalExpected : null;
  // gatingOnsetFalsePositives is the TOTAL unmatched-detection count (in + outside rest windows);
  // subtract the rest-window subset to get the "outside" figure actually being gated below.
  const onsetFalsePositivesOutsideRest = gatingOnsetFalsePositives - gatingOnsetRestFalsePositives;
  const passOnsetRecall = onsetRecall >= 0.9;
  const passOnsetFalsePositives = onsetFalsePositivesOutsideRest <= 1;
  const passOnsetRestFalsePositives = gatingOnsetRestFalsePositives === 0;

  console.log("=== Phase 0 Offline Validation ===");
  console.log(`Steady accuracy: ${(steadyAccuracy * 100).toFixed(2)}% (target >= 95%)`);
  console.log(`Octave errors: ${octaveErrors} (target <= 1)`);
  console.log(`Rest clean rate: ${(restCleanRate * 100).toFixed(2)}% (target high, no spurious notes)`);
  // This is how fast PitchDetector's own smoothing stabilizes on the correct note after a note
  // begins -- it does NOT exercise OnsetDetector (the spectral-flux class ScoreFollower actually
  // depends on). See the "Onset recall"/"Onset false positives" lines below for that.
  console.log(`Mean pitch-stabilization latency (post-onset, pitch-detector-only proxy): ${meanOnsetLatency.toFixed(1)}ms (target <= 150ms)`);
  console.log(`Onset recall: ${(onsetRecall * 100).toFixed(2)}% (target >= 90%)`);
  console.log(`Onset false positives outside rest windows: ${onsetFalsePositivesOutsideRest} (target <= 1)`);
  console.log(`Onset false positives inside rest windows: ${gatingOnsetRestFalsePositives} (target == 0)`);
  if (diagnosticOnsetRecall !== null) {
    console.log(`[diagnostic, not gated] Very-fast-sequence onset recall: ${(diagnosticOnsetRecall * 100).toFixed(2)}% (limited by minOnsetIntervalMs debounce)`);
  }

  const allPassed =
    passSteadyAccuracy &&
    passOctaveErrors &&
    passRestHandling &&
    passLatency &&
    passOnsetRecall &&
    passOnsetFalsePositives &&
    passOnsetRestFalsePositives;
  if (!allPassed) {
    console.error("Validation failed. Tune thresholds/filtering before Phase 1.");
    process.exit(1);
  }

  console.log("Validation passed. Phase 0 acceptance gate cleared.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});