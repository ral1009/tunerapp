import fs from "node:fs";
import path from "node:path";

interface SyntheticClipSpec {
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
	clips: SyntheticClipSpec[];
}

interface StaticNoteDefinition {
	kind: "static";
	note: string;
	frequencyHz: number;
	fileName: string;
}

interface VibratoNoteDefinition {
	kind: "vibrato";
	note: string;
	centerFrequencyHz: number;
	vibratoRateHz: number;
	vibratoDepthSemitones: number;
	fileName: string;
}

type NoteDefinition = StaticNoteDefinition | VibratoNoteDefinition;

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const CLIP_DURATION_MS = 2200;
const STEADY_START_MS = 250;
const STEADY_END_MS = 1700;
const REST_WINDOWS_MS: Array<[number, number]> = [
	[0, 180],
	[1800, 2200]
];

// These are synthetic-only additions layered on top of the real recorded clips already
// checked into ground-truth.json (open-*.wav / fingered-*.wav). They intentionally do NOT
// reuse those filenames or note names, because this script's --overwrite regeneration is
// destructive: reusing a real recording's filename would silently replace real mic audio
// with a synthetic tone. Only entries listed here are ever (re)generated.
const NOTE_DEFINITIONS: NoteDefinition[] = [
	// Highest note in the current dataset was G#5 (830.61Hz), far from the ~3.5kHz violin
	// ceiling this app targets. G7 stresses detection near that upper bound without
	// exceeding MAX_DETECTABLE_FREQUENCY_HZ.
	{ kind: "static", note: "G7", frequencyHz: 3135.96, fileName: "synthetic-high-g7.wav" },
	// All existing clips (real and synthetic) are static-envelope held tones. This adds
	// frequency modulation typical of violin vibrato to check the pitch detector's median
	// smoother stays on the correct note name through continuous pitch wobble.
	{
		kind: "vibrato",
		note: "A4",
		centerFrequencyHz: 440.0,
		vibratoRateHz: 5.5,
		vibratoDepthSemitones: 0.35,
		fileName: "synthetic-vibrato-a4.wav"
	}
];

function parseArgs(argv: string[]): { overwrite: boolean } {
	return {
		overwrite: argv.includes("--overwrite")
	};
}

function createEnvelope(timeMs: number): number {
	if (timeMs < STEADY_START_MS || timeMs > STEADY_END_MS) {
		return 0;
	}

	const attackMs = 80;
	const releaseMs = 100;
	const attackProgress = Math.min(1, Math.max(0, (timeMs - STEADY_START_MS) / attackMs));
	const releaseProgress = Math.min(1, Math.max(0, (STEADY_END_MS - timeMs) / releaseMs));
	const smoothStep = Math.min(attackProgress, releaseProgress);
	return smoothStep * smoothStep * (3 - 2 * smoothStep);
}

function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (1664525 * state + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function hashString(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash;
}

function clamp16Bit(value: number): number {
	return Math.max(-32768, Math.min(32767, value));
}

function encodeWavMono16(samples: Float32Array, sampleRate: number): Buffer {
	const dataSize = samples.length * 2;
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataSize, 40);

	for (let index = 0; index < samples.length; index += 1) {
		buffer.writeInt16LE(clamp16Bit(Math.round(samples[index] * 32767)), 44 + index * 2);
	}

	return buffer;
}

function generateClip(frequencyHz: number, fileName: string): Float32Array {
	const totalSamples = Math.round((CLIP_DURATION_MS / 1000) * SAMPLE_RATE);
	const samples = new Float32Array(totalSamples);
	const random = createSeededRandom(hashString(fileName));
	const basePhase = random() * Math.PI * 2;
	const slightDetune = 1 + (random() - 0.5) * 0.0005;

	for (let index = 0; index < totalSamples; index += 1) {
		const timeSeconds = index / SAMPLE_RATE;
		const timeMs = timeSeconds * 1000;
		const envelope = createEnvelope(timeMs);
		const phase = 2 * Math.PI * frequencyHz * slightDetune * timeSeconds + basePhase;
		const harmonicBlend =
			0.94 * Math.sin(phase) +
			0.04 * Math.sin(phase * 2.001) +
			0.015 * Math.sin(phase * 3.003) +
			0.005 * Math.sin(phase * 4.004);
		const attackNoise = timeMs < STEADY_START_MS + 50 ? (random() - 0.5) * 0.004 : 0;
		const breathNoise = (random() - 0.5) * 0.0015;

		samples[index] = envelope * harmonicBlend + attackNoise + breathNoise * envelope;
	}

	return samples;
}

function generateVibratoClip(
	centerFrequencyHz: number,
	vibratoRateHz: number,
	vibratoDepthSemitones: number,
	fileName: string
): Float32Array {
	const totalSamples = Math.round((CLIP_DURATION_MS / 1000) * SAMPLE_RATE);
	const samples = new Float32Array(totalSamples);
	const random = createSeededRandom(hashString(fileName));
	const basePhase = random() * Math.PI * 2;

	let phase = basePhase;
	for (let index = 0; index < totalSamples; index += 1) {
		const timeSeconds = index / SAMPLE_RATE;
		const timeMs = timeSeconds * 1000;
		const envelope = createEnvelope(timeMs);

		// Vibrato only ramps in once the note has settled, like a real player easing into it.
		const vibratoRampProgress = Math.min(1, Math.max(0, (timeMs - STEADY_START_MS - 150) / 250));
		const vibratoSemitones = vibratoDepthSemitones * vibratoRampProgress * Math.sin(2 * Math.PI * vibratoRateHz * timeSeconds);
		const instantaneousFrequencyHz = centerFrequencyHz * Math.pow(2, vibratoSemitones / 12);

		phase += (2 * Math.PI * instantaneousFrequencyHz) / SAMPLE_RATE;

		const harmonicBlend =
			0.94 * Math.sin(phase) +
			0.04 * Math.sin(phase * 2.001) +
			0.015 * Math.sin(phase * 3.003) +
			0.005 * Math.sin(phase * 4.004);
		const attackNoise = timeMs < STEADY_START_MS + 50 ? (random() - 0.5) * 0.004 : 0;
		const breathNoise = (random() - 0.5) * 0.0015;

		samples[index] = envelope * harmonicBlend + attackNoise + breathNoise * envelope;
	}

	return samples;
}

function ensureDirectory(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
}

function loadExistingSpec(groundTruthPath: string): ValidationSpec | null {
	if (!fs.existsSync(groundTruthPath)) {
		return null;
	}

	return JSON.parse(fs.readFileSync(groundTruthPath, "utf8")) as ValidationSpec;
}

function main(): void {
	const { overwrite } = parseArgs(process.argv.slice(2));
	const root = path.resolve(process.cwd(), "audio", "__tests__", "offline-validation");
	const datasetDir = path.join(root, "dataset");
	const groundTruthPath = path.join(root, "ground-truth.json");

	ensureDirectory(datasetDir);

	const targetFiles = NOTE_DEFINITIONS.map((definition) => path.join(datasetDir, definition.fileName));
	const existingTargetFiles = targetFiles.filter((filePath) => fs.existsSync(filePath));
	if (existingTargetFiles.length > 0 && !overwrite) {
		throw new Error(`Refusing to overwrite existing files:\n${existingTargetFiles.join("\n")}\nRe-run with --overwrite.`);
	}

	const newClips: SyntheticClipSpec[] = [];

	for (const definition of NOTE_DEFINITIONS) {
		const filePath = path.join(datasetDir, definition.fileName);
		const samples =
			definition.kind === "static"
				? generateClip(definition.frequencyHz, definition.fileName)
				: generateVibratoClip(
						definition.centerFrequencyHz,
						definition.vibratoRateHz,
						definition.vibratoDepthSemitones,
						definition.fileName
					);
		const wavBuffer = encodeWavMono16(samples, SAMPLE_RATE);
		fs.writeFileSync(filePath, wavBuffer);

		newClips.push({
			file: path.join("dataset", definition.fileName).split(path.sep).join("/"),
			expectedNote: definition.note,
			expectedFrequencyHz: definition.kind === "static" ? definition.frequencyHz : definition.centerFrequencyHz,
			steadyStartMs: STEADY_START_MS,
			steadyEndMs: STEADY_END_MS,
			restWindowsMs: REST_WINDOWS_MS
		});
	}

	const existingSpec = loadExistingSpec(groundTruthPath);
	const newClipFiles = new Set(newClips.map((clip) => clip.file));
	const preservedClips = existingSpec ? existingSpec.clips.filter((clip) => !newClipFiles.has(clip.file)) : [];

	const spec: ValidationSpec = {
		sampleRate: existingSpec?.sampleRate ?? SAMPLE_RATE,
		frameSize: existingSpec?.frameSize ?? FRAME_SIZE,
		hopSize: existingSpec?.hopSize ?? HOP_SIZE,
		clips: [...preservedClips, ...newClips]
	};

	fs.writeFileSync(groundTruthPath, `${JSON.stringify(spec, null, 2)}\n`);

	console.log(`Generated ${newClips.length} synthetic clips in ${datasetDir}`);
	console.log(`Merged into validation spec at ${groundTruthPath} (${preservedClips.length} existing clips preserved)`);
}

main();
