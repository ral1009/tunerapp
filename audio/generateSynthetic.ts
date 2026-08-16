import fs from "node:fs";
import path from "node:path";

interface SyntheticClipSpec {
	file: string;
	// Pitch-accuracy fields -- optional so a clip can be onset-only (see ClipSpec in
	// runValidation.ts, which this mirrors).
	expectedNote?: string;
	expectedFrequencyHz?: number;
	steadyStartMs?: number;
	steadyEndMs?: number;
	restWindowsMs: Array<[number, number]>;
	expectedOnsetsMs?: number[];
	onsetDiagnosticOnly?: boolean;
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

// A sequence of distinct notes played back-to-back, each with its OWN attack/release envelope
// (discrete bow-stroke-like attacks, not a continuous legato slur) -- for onset-detector
// validation. noteDurationMs is attack-to-attack spacing, not audible duration; attackMs/
// releaseMs shape each note's own smoothstep envelope within that slot.
interface SequenceNoteDefinition {
	kind: "sequence";
	fileName: string;
	notes: Array<{ note: string; frequencyHz: number }>;
	noteDurationMs: number;
	attackMs: number;
	releaseMs: number;
	leadInMs: number;
	trailOutMs: number;
	onsetDiagnosticOnly?: boolean;
}

// Pure broadband noise, no tonal content at all -- for testing that OnsetDetector's spectral
// flux doesn't false-trigger on background noise alone (the app's own live testing found real
// room/background noise misdetected as high-confidence pitch readings).
interface NoiseOnlyDefinition {
	kind: "noise";
	fileName: string;
	durationMs: number;
	amplitude: number;
}

type NoteDefinition = StaticNoteDefinition | VibratoNoteDefinition | SequenceNoteDefinition | NoiseOnlyDefinition;

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

// G major diatonic scale, comfortably within violin range, reused across the two sequence
// fixtures below.
const SCALE_NOTES: Array<{ note: string; frequencyHz: number }> = [
	{ note: "G4", frequencyHz: 392.0 },
	{ note: "A4", frequencyHz: 440.0 },
	{ note: "B4", frequencyHz: 493.88 },
	{ note: "C5", frequencyHz: 523.25 },
	{ note: "D5", frequencyHz: 587.33 },
	{ note: "E5", frequencyHz: 659.25 },
	{ note: "F#5", frequencyHz: 739.99 },
	{ note: "G5", frequencyHz: 783.99 }
];

// Separate from NOTE_DEFINITIONS above (which are single-note pitch-accuracy fixtures) --
// these are onset-only fixtures for the OnsetDetector validation harness (runValidation.ts).
const ONSET_SEQUENCE_DEFINITIONS: SequenceNoteDefinition[] = [
	// Primary gating fixture: distinct, separately-bowed notes at a real "fast passage" tempo
	// (180ms/note, comfortably above minOnsetIntervalMs's 70ms floor) -- this is what should
	// catch fluxThreshold being too high to notice legato-ish fast transitions.
	{
		kind: "sequence",
		fileName: "synthetic-sequence-fast-scale.wav",
		notes: SCALE_NOTES,
		noteDurationMs: 180,
		attackMs: 15,
		releaseMs: 25,
		leadInMs: 300,
		trailOutMs: 300
	},
	// Same notes, faster than minOnsetIntervalMs (60ms/note) -- recall here is mechanically
	// capped by that debounce floor regardless of fluxThreshold, so it's diagnostic-only and
	// must not block the gate.
	{
		kind: "sequence",
		fileName: "synthetic-sequence-very-fast-scale.wav",
		notes: SCALE_NOTES,
		noteDurationMs: 60,
		attackMs: 10,
		releaseMs: 15,
		leadInMs: 300,
		trailOutMs: 300,
		onsetDiagnosticOnly: true
	}
];

const NOISE_ONLY_DEFINITIONS: NoiseOnlyDefinition[] = [
	// Pure background noise, no tonal content -- directly tests whether spectral flux alone can
	// false-trigger an onset on noise, independent of the RMS/pitch-confidence gates production
	// layers on top (see runValidation.ts's documented scope boundary). Amplitude is a rough
	// stand-in for a quiet room / mic self-noise floor, well below the note envelopes above.
	{
		kind: "noise",
		fileName: "synthetic-sequence-silence-only.wav",
		durationMs: 3000,
		amplitude: 0.01
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

function generateSequenceClip(definition: SequenceNoteDefinition): { samples: Float32Array; onsetsMs: number[] } {
	const totalDurationMs = definition.leadInMs + definition.notes.length * definition.noteDurationMs + definition.trailOutMs;
	const totalSamples = Math.round((totalDurationMs / 1000) * SAMPLE_RATE);
	const samples = new Float32Array(totalSamples);
	const onsetsMs: number[] = [];

	for (let noteIndex = 0; noteIndex < definition.notes.length; noteIndex += 1) {
		const { frequencyHz } = definition.notes[noteIndex];
		const noteStartMs = definition.leadInMs + noteIndex * definition.noteDurationMs;
		onsetsMs.push(noteStartMs);

		// Keyed per-note (not just per-file) so consecutive notes in a fast run aren't
		// bit-identical in their detune/noise, closer to how a real player's successive bow
		// strokes vary slightly.
		const random = createSeededRandom(hashString(`${definition.fileName}#${noteIndex}`));
		const basePhase = random() * Math.PI * 2;
		const slightDetune = 1 + (random() - 0.5) * 0.0005;

		const noteStartSample = Math.round((noteStartMs / 1000) * SAMPLE_RATE);
		const noteEndSample = Math.min(totalSamples, Math.round(((noteStartMs + definition.noteDurationMs) / 1000) * SAMPLE_RATE));

		for (let sampleIndex = noteStartSample; sampleIndex < noteEndSample; sampleIndex += 1) {
			const timeSeconds = sampleIndex / SAMPLE_RATE;
			const timeIntoNoteMs = ((sampleIndex - noteStartSample) / SAMPLE_RATE) * 1000;
			const attackProgress = Math.min(1, Math.max(0, timeIntoNoteMs / definition.attackMs));
			const releaseProgress = Math.min(1, Math.max(0, (definition.noteDurationMs - timeIntoNoteMs) / definition.releaseMs));
			const smoothStepInput = Math.min(attackProgress, releaseProgress);
			const envelope = smoothStepInput * smoothStepInput * (3 - 2 * smoothStepInput);

			const phase = 2 * Math.PI * frequencyHz * slightDetune * timeSeconds + basePhase;
			const harmonicBlend =
				0.94 * Math.sin(phase) +
				0.04 * Math.sin(phase * 2.001) +
				0.015 * Math.sin(phase * 3.003) +
				0.005 * Math.sin(phase * 4.004);
			const attackNoise = timeIntoNoteMs < 50 ? (random() - 0.5) * 0.004 : 0;
			const breathNoise = (random() - 0.5) * 0.0015;

			samples[sampleIndex] = envelope * harmonicBlend + attackNoise + breathNoise * envelope;
		}
	}

	return { samples, onsetsMs };
}

function generateNoiseOnlyClip(durationMs: number, fileName: string, amplitude: number): Float32Array {
	const totalSamples = Math.round((durationMs / 1000) * SAMPLE_RATE);
	const samples = new Float32Array(totalSamples);
	const random = createSeededRandom(hashString(fileName));

	for (let index = 0; index < totalSamples; index += 1) {
		samples[index] = (random() - 0.5) * 2 * amplitude;
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

	const allDefinitions: NoteDefinition[] = [...NOTE_DEFINITIONS, ...ONSET_SEQUENCE_DEFINITIONS, ...NOISE_ONLY_DEFINITIONS];
	const targetFiles = allDefinitions.map((definition) => path.join(datasetDir, definition.fileName));
	const existingTargetFiles = targetFiles.filter((filePath) => fs.existsSync(filePath));
	if (existingTargetFiles.length > 0 && !overwrite) {
		throw new Error(`Refusing to overwrite existing files:\n${existingTargetFiles.join("\n")}\nRe-run with --overwrite.`);
	}

	const newClips: SyntheticClipSpec[] = [];

	for (const definition of allDefinitions) {
		const filePath = path.join(datasetDir, definition.fileName);
		const relativeFile = path.join("dataset", definition.fileName).split(path.sep).join("/");

		if (definition.kind === "sequence") {
			const { samples, onsetsMs } = generateSequenceClip(definition);
			fs.writeFileSync(filePath, encodeWavMono16(samples, SAMPLE_RATE));

			const totalDurationMs = definition.leadInMs + definition.notes.length * definition.noteDurationMs + definition.trailOutMs;
			const lastNoteEndMs = definition.leadInMs + definition.notes.length * definition.noteDurationMs;
			newClips.push({
				file: relativeFile,
				expectedOnsetsMs: onsetsMs,
				onsetDiagnosticOnly: definition.onsetDiagnosticOnly,
				restWindowsMs: [
					[0, Math.max(0, definition.leadInMs - 30)],
					[lastNoteEndMs + 30, totalDurationMs]
				]
			});
			continue;
		}

		if (definition.kind === "noise") {
			const samples = generateNoiseOnlyClip(definition.durationMs, definition.fileName, definition.amplitude);
			fs.writeFileSync(filePath, encodeWavMono16(samples, SAMPLE_RATE));

			newClips.push({
				file: relativeFile,
				expectedOnsetsMs: [],
				restWindowsMs: [[0, definition.durationMs]]
			});
			continue;
		}

		const samples =
			definition.kind === "static"
				? generateClip(definition.frequencyHz, definition.fileName)
				: generateVibratoClip(
						definition.centerFrequencyHz,
						definition.vibratoRateHz,
						definition.vibratoDepthSemitones,
						definition.fileName
					);
		fs.writeFileSync(filePath, encodeWavMono16(samples, SAMPLE_RATE));

		newClips.push({
			file: relativeFile,
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
