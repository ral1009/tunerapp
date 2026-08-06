import fs from "node:fs";
import path from "node:path";
import WavDecoder from "wav-decoder";
import { PitchDetector } from "../../pitchDetector";

interface ClipSpec {
  file: string;
  expectedNote: string;
  expectedFrequencyHz: number;
  steadyStartMs: number;
  steadyEndMs: number;
  restWindowsMs: Array<[number, number]>;
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

function loadSpec(specPath: string): ValidationSpec {
  if (!fs.existsSync(specPath)) {
    throw new Error(`Missing ${specPath}. Copy ground-truth.example.json and fill real clip metadata.`);
  }

  return JSON.parse(fs.readFileSync(specPath, "utf8")) as ValidationSpec;
}

async function loadMonoWav(filePath: string): Promise<{ sampleRate: number; samples: Float32Array }> {
  const buffer = fs.readFileSync(filePath);
  const audioData = await WavDecoder.decode(buffer);
  if (audioData.channelData.length === 0) {
    throw new Error(`No channel data in ${filePath}`);
  }

  return {
    sampleRate: audioData.sampleRate,
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
      confidenceThreshold: 0.15,
      smoothingWindowFrames: 5,
      expectedNoteWindowSemitones: 3
    });

    if (wav.sampleRate !== spec.sampleRate) {
      console.warn(`Sample rate mismatch for ${clip.file}: got ${wav.sampleRate}, metadata says ${spec.sampleRate}`);
    }

    const frames = stableFrameResults(
      wav.samples,
      wav.sampleRate,
      spec.frameSize,
      spec.hopSize,
      detector,
      clip.expectedFrequencyHz
    );

    for (const frame of frames) {
      if (withinWindow(frame.ms, clip.steadyStartMs, clip.steadyEndMs)) {
        totalSteadyFrames += 1;
        if (frame.note === clip.expectedNote) {
          correctSteadyFrames += 1;
        }
        if (frame.note && octaveDifference(frame.note, clip.expectedNote) >= 1 && frame.note !== clip.expectedNote) {
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

    const firstStableMs = firstStableCorrectFrameMs(frames, clip.expectedNote, clip.steadyStartMs);
    if (firstStableMs !== null) {
      onsetLatenciesMs.push(firstStableMs - clip.steadyStartMs);
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

  console.log("=== Phase 0 Offline Validation ===");
  console.log(`Steady accuracy: ${(steadyAccuracy * 100).toFixed(2)}% (target >= 95%)`);
  console.log(`Octave errors: ${octaveErrors} (target <= 1)`);
  console.log(`Rest clean rate: ${(restCleanRate * 100).toFixed(2)}% (target high, no spurious notes)`);
  console.log(`Mean onset latency: ${meanOnsetLatency.toFixed(1)}ms (target <= 150ms)`);

  const allPassed = passSteadyAccuracy && passOctaveErrors && passRestHandling && passLatency;
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