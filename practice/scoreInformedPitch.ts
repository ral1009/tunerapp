// Score-informed pitch measurement for post-take grading.
//
// The live detector (audio/pitchDetector.ts) answers "what pitch is sounding?", which fails whenever
// two pitches overlap -- and in fast violin passages they nearly always do: the previous note, or an
// open string crossed on the way, keeps ringing under the new one. Most fast notes in real
// recordings came back with no usable reading at all (an independent tracker, pYIN, failed on the
// same notes), so they couldn't be graded.
//
// After the take, the question is narrower: the alignment says WHICH written note was sounding over
// a span of audio, so we only need to measure how far that note's pitch is from where it should be.
// This does that directly:
//
// 1. One spectrum over the note's whole settled span (Hann window, zero-padded), instead of many
//    short frames. Frequency resolution grows with window length, and cents precision improves
//    further with each harmonic used, so even a short note gets one well-resolved measurement.
//    For a long note with vibrato this is the vibrato's centre, which is what intonation means.
// 2. Harmonic salience: for candidate fundamentals within +-SEARCH_CENTS of the written pitch, sum
//    the (log-compressed) spectral magnitude at each harmonic. A ringing note at a different pitch
//    puts its energy at different frequencies, so it can't win unless its harmonics happen to line
//    up with the written note's across the board.
// 3. A presence test, so a note that isn't there isn't graded: the winning candidate's salience
//    must stand out from the salience of random frequencies in the same spectrum. The threshold
//    is calibrated on pure noise (see PRESENCE_Z_THRESHOLD), never on violin recordings.
//
// Pure functions, no DOM: runs in the browser and under the Node harnesses.
import { fftInPlace } from "../audio/fft";

// Search range around the written pitch. Intonation errors worth grading are well inside this; a
// note 80+ cents off is effectively a different note. It was +-150 at first, and that measured
// the WRONG thing whenever the played note was unreadable but another pitch a semitone away was
// ringing (common in arpeggiated passages): on synthetic polyphony a pitch nobody played still got
// a reading 24% of the time at +-150, 6% at +-80 (before the dominance test below).
export const SEARCH_CENTS = 80;
const SEARCH_STEP_CENTS = 2;
// Harmonics summed, stopping below MAX_HARMONIC_HZ (above that, violin partials are weak and
// the band-limited capture path rolls off).
const MAX_HARMONICS = 8;
const MAX_HARMONIC_HZ = 5000;
// Shortest span worth measuring. ~2.5 periods of open G; below this there isn't a pitch to measure.
export const MIN_SPAN_SECONDS = 0.025;
// Longest span analyzed per note (a long note's middle is plenty, and it bounds FFT cost).
const MAX_SPAN_SECONDS = 1.0;
const MAX_FFT_SIZE = 1 << 17;
// Presence: winning salience must exceed the mean of reference salience by this many standard
// deviations, where the reference is the same harmonic-sum measured at frequencies unrelated to
// the written pitch, in the same spectrum. Calibrated on white and pink noise across the violin
// range and span lengths 30 ms-1 s (scoreInformedPitch calibration in
// practice/__tests__/offline-scorer-harness.ts): noise exceeds 3.0 in well under 1% of trials.
export const PRESENCE_Z_THRESHOLD = 3.0;
const OPEN_STRINGS_HZ = [196.0, 293.66, 440.0, 659.26];
// See the level normalization in measureScoreInformedPitch.
const REFERENCE_RMS = 0.001;
// Set from synthetic signals only (a played note plus a louder and an equal ringing note at random
// intervals, 50-500 ms): 0.5 keeps 98% of played notes and accepts 1.7% of pitches nobody plays.
const DOMINANCE_THRESHOLD = 0.5;
// See harmonicStandsOut. Margin is in log-magnitude units (log1p(1000*|X|)); ~0.7 is about a 2x
// magnitude ratio for partials well above the noise floor.
const HARMONIC_PEAK_MARGIN = 0.7;
const MIN_SUPPORTED_HARMONICS = 3;

export interface ScoreInformedReading {
  frequencyHz: number;
  centsOff: number;
  // How far the note's harmonic energy stands out from the rest of the spectrum (z-score).
  presence: number;
  // The note's salience relative to the strongest unrelated pitch in the spectrum (1 = as strong as
  // the strongest; see DOMINANCE_THRESHOLD).
  dominance: number;
}

function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size <<= 1;
  return size;
}

function logMagnitudeSpectrum(segment: Float32Array, fftSize: number): Float64Array {
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const n = segment.length;
  for (let i = 0; i < n; i += 1) {
    real[i] = segment[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fftInPlace(real, imag);
  const bins = fftSize >> 1;
  const out = new Float64Array(bins);
  // Log compression: keeps one loud partial (often the 2nd or 3rd on violin) from deciding the sum
  // alone, the usual choice for harmonic-sum pitch estimation.
  for (let i = 0; i < bins; i += 1) {
    out[i] = Math.log1p(1000 * Math.hypot(real[i], imag[i]));
  }
  return out;
}

function magnitudeAt(spectrum: Float64Array, hz: number, binHz: number): number {
  const position = hz / binHz;
  const index = Math.floor(position);
  if (index < 0 || index + 1 >= spectrum.length) return 0;
  const frac = position - index;
  return spectrum[index] * (1 - frac) + spectrum[index + 1] * frac;
}

// Is there a spectral peak at `hz`, above the spectrum in the band around it? The band is +-1.5
// semitones excluding the central +-40 cents (the peak's own main lobe on short spans).
function harmonicStandsOut(spectrum: Float64Array, hz: number, binHz: number): boolean {
  const center = magnitudeAt(spectrum, hz, binHz);
  const around: number[] = [];
  for (let c = -150; c <= 150; c += 10) {
    if (Math.abs(c) < 40) continue;
    around.push(magnitudeAt(spectrum, hz * Math.pow(2, c / 1200), binHz));
  }
  around.sort((a, b) => a - b);
  return center > around[Math.floor(around.length / 2)] + HARMONIC_PEAK_MARGIN;
}

// Copy of the spectrum with every partial of f0 replaced by the spectrum's median, over the
// partial's main lobe and first sidelobes, measured in bins of the UNPADDED span.
function maskHarmonics(spectrum: Float64Array, fundamentalsHz: readonly number[], binHz: number, unpaddedBinHz: number): Float64Array {
  // One copy for every pitch being masked (this note, its neighbours, the open strings) rather
  // than one full-spectrum copy per pitch, and only up to where salience ever reads.
  const out = Float64Array.from(spectrum);
  // Median from every 8th bin: sorting all of a 64k-bin spectrum per note dominated run time.
  const sample = new Float64Array(Math.ceil(spectrum.length / 8));
  for (let i = 0, j = 0; i < spectrum.length; i += 8, j += 1) sample[j] = spectrum[i];
  sample.sort();
  const floor = sample[Math.floor(sample.length / 2)];
  // +-4 bins: the main lobe (+-2) plus the first sidelobes, which log compression keeps visible.
  const halfWidthHz = 4 * unpaddedBinHz;
  const topHz = Math.min(spectrum.length * binHz, MAX_HARMONIC_HZ * 1.1);
  for (const f0 of fundamentalsHz) {
    for (let h = 1; h * f0 < topHz; h += 1) {
      const from = Math.max(0, Math.floor((h * f0 - halfWidthHz) / binHz));
      const to = Math.min(spectrum.length - 1, Math.ceil((h * f0 + halfWidthHz) / binHz));
      for (let i = from; i <= to; i += 1) out[i] = floor;
    }
  }
  return out;
}

function salience(spectrum: Float64Array, f0: number, binHz: number): number {
  let sum = 0;
  for (let h = 1; h <= MAX_HARMONICS && h * f0 < MAX_HARMONIC_HZ; h += 1) {
    // Gentle 1/sqrt(h) weighting: favours the fundamental region without ignoring upper partials,
    // which carry the finest cents information.
    sum += magnitudeAt(spectrum, h * f0, binHz) / Math.sqrt(h);
  }
  return sum;
}

// Measure the written note's actual pitch in `segment`, or null if it isn't clearly present.
//
// `contextHz`: pitches likely to be ringing under this note -- the previous and next written
// notes. The violin's open strings are always added. Their partials are masked out of the
// presence reference along with this note's own (see below), so overlap doesn't make a real note
// look absent. They are NOT excluded from the pitch search itself.
export function measureScoreInformedPitch(
  segment: Float32Array,
  sampleRate: number,
  expectedHz: number,
  contextHz: readonly number[] = []
): ScoreInformedReading | null {
  if (segment.length < MIN_SPAN_SECONDS * sampleRate || expectedHz <= 0) return null;
  let span = segment;
  const maxSamples = Math.floor(MAX_SPAN_SECONDS * sampleRate);
  if (span.length > maxSamples) {
    const start = Math.floor((span.length - maxSamples) / 2);
    span = span.subarray(start, start + maxSamples);
  }
  // Level normalization. The log compression below is not scale-invariant, so the same note gave
  // different presence scores at different input levels: a real take recorded with the capture
  // module's 32x software gain had 60% of clearly-played notes rejected (presence z ~2.7), and the
  // identical audio at unity gain read them all (z ~4.3). Every span is brought to the RMS the
  // thresholds were calibrated at (synthetic signals peaking around 0.2-0.3), so mic gain and
  // playing volume no longer change the outcome.
  let energy = 0;
  for (let i = 0; i < span.length; i += 1) energy += span[i] * span[i];
  const rms = Math.sqrt(energy / span.length);
  if (rms <= 0) return null;
  const normalized = new Float32Array(span.length);
  const scale = REFERENCE_RMS / rms;
  for (let i = 0; i < span.length; i += 1) normalized[i] = span[i] * scale;
  span = normalized;
  // Zero-pad to ~4x for a smooth spectrum to interpolate on.
  const fftSize = Math.min(MAX_FFT_SIZE, nextPowerOfTwo(span.length * 4));
  const spectrum = logMagnitudeSpectrum(span, fftSize);
  const binHz = sampleRate / fftSize;

  const steps = Math.round(SEARCH_CENTS / SEARCH_STEP_CENTS);
  const values: number[] = [];
  let best = -Infinity;
  let bestIndex = 0;
  for (let k = -steps; k <= steps; k += 1) {
    const value = salience(spectrum, expectedHz * Math.pow(2, (k * SEARCH_STEP_CENTS) / 1200), binHz);
    values.push(value);
    if (value > best) {
      best = value;
      bestIndex = k + steps;
    }
  }
  // A maximum on the edge of the search range means the strongest energy is outside it: whatever
  // is sounding isn't this note (or is more than SEARCH_CENTS off, which is a different note).
  if (bestIndex === 0 || bestIndex === values.length - 1) return null;

  // Pitch = centroid of the salience curve's upper half, not its peak. With vibrato the pitch
  // spends most of its time near the two turning points, so a whole-span spectrum shows two humps
  // at +-depth and the peak sits on one of them: the peak version read synthetic +-30 cent vibrato
  // ~23 cents off. The centroid of the region above halfway between the curve's floor and its
  // peak lands between the humps, on the centre the player is aiming at; for a steady note it's
  // the peak itself.
  let floorValue = Infinity;
  for (const v of values) floorValue = Math.min(floorValue, v);
  const half = floorValue + 0.5 * (best - floorValue);
  let weightSum = 0;
  let weighted = 0;
  for (let i = 0; i < values.length; i += 1) {
    const w = values[i] - half;
    if (w > 0) {
      weightSum += w;
      weighted += w * (i - steps) * SEARCH_STEP_CENTS;
    }
  }
  const cents = weightSum > 0 ? weighted / weightSum : (bestIndex - steps) * SEARCH_STEP_CENTS;

  // Presence is judged against what the SAME search finds when there's no note to find: the best
  // salience over equally wide windows centred on frequencies across 1.5 octaves either side, in
  // this same spectrum with this note's own partials removed. Two details matter:
  // - window MAXIMA, not single-frequency values. A long span has a finer spectrum, so the search
  //   tries more independent candidates and its maximum is higher by chance alone (noise passed
  //   40% of the time on 1-second spans when compared against single values);
  // - the note's partials masked out first. Otherwise reference windows whose harmonics line up
  //   with the note's (ratios like 5/4 or 5/3) borrow its energy and make a real note look absent.
  //   Likely-ringing neighbours (contextHz, open strings) are masked too, or a loud previous note
  //   inflates every reference window and a real note looks absent (synthetic test: 96% of
  //   overlapped 100 ms notes read without masking it, 36% with). A wrong note actually played is
  //   in neither list, so it stays unmasked and is still rejected.
  const f0Best = expectedHz * Math.pow(2, ((bestIndex - steps) * SEARCH_STEP_CENTS) / 1200);
  // Skip anything close enough to this note that masking it would mask this note too.
  const others = [...contextHz, ...OPEN_STRINGS_HZ].filter((hz) => hz > 0 && Math.abs(1200 * Math.log2(hz / expectedHz)) > SEARCH_CENTS);
  const masked = maskHarmonics(spectrum, [f0Best, ...others], binHz, sampleRate / span.length);
  const reference: number[] = [];
  for (let c = -1750; c <= 1750; c += 125) {
    if (Math.abs(c) < SEARCH_CENTS + 50) continue;
    const ratio = Math.pow(2, c / 1200);
    let windowBest = -Infinity;
    for (let k = -steps; k <= steps; k += 1) {
      windowBest = Math.max(windowBest, salience(masked, expectedHz * ratio * Math.pow(2, (k * SEARCH_STEP_CENTS) / 1200), binHz));
    }
    reference.push(windowBest);
  }
  const mean = reference.reduce((sum, v) => sum + v, 0) / reference.length;
  const sd = Math.sqrt(reference.reduce((sum, v) => sum + (v - mean) ** 2, 0) / reference.length) || 1e-9;
  const presence = (best - mean) / sd;
  if (presence < PRESENCE_Z_THRESHOLD) return null;

  // Harmonic support: a real note shows up as several of ITS OWN partials, each standing out from
  // the spectrum right around it, with the fundamental or octave among them. Without this, a long
  // held wrong note could pass on one upper partial that happens to coincide with one of the
  // written note's (e.g. the 5th harmonic of a note 3 semitones up sits 16 cents from the written
  // note's 6th).
  const f0 = expectedHz * Math.pow(2, cents / 1200);
  let supported = 0;
  let lowSupported = false;
  for (let h = 1; h <= MAX_HARMONICS && h * f0 < MAX_HARMONIC_HZ; h += 1) {
    if (harmonicStandsOut(spectrum, h * f0, binHz)) {
      supported += 1;
      if (h <= 2) lowSupported = true;
    }
  }
  if (supported < MIN_SUPPORTED_HARMONICS || !lowSupported) return null;

  // Dominance: on real recordings several pitches ring at once (reverb, sympathetic strings,
  // arpeggiated chords), and the tests above alone accepted SOMETHING within +-150 cents of a
  // pitch a tritone away from what was played in 29-46% of notes. A note that is actually being
  // played is among the strongest pitches in its own span; a pitch nobody is playing is not. Its
  // salience above the reference floor must be at least DOMINANCE_THRESHOLD of the strongest
  // other pitch's (it doesn't have to be the loudest: the previous note is often louder), across 1.5 octaves either side (pitches harmonically related to this one are
  // skipped: a harmonic sum at f/2 or 2f partly re-counts this note's own partials).
  let strongestOther = -Infinity;
  for (let semis = -18; semis <= 18; semis += 1) {
    if (Math.abs(semis) < 2) continue;
    if ([-12, 12, -7, 7, 19, -19].includes(semis)) continue;
    for (let c = -40; c <= 40; c += 10) {
      strongestOther = Math.max(strongestOther, salience(spectrum, expectedHz * Math.pow(2, (semis * 100 + c) / 1200), binHz));
    }
  }
  const dominance = strongestOther > mean ? (best - mean) / (strongestOther - mean) : Infinity;
  if (dominance < DOMINANCE_THRESHOLD) return null;

  return { frequencyHz: expectedHz * Math.pow(2, cents / 1200), centsOff: cents, presence, dominance };
}
