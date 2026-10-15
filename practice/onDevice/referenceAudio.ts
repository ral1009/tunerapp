// The reference the live audio is aligned to: the score rendered as audio by the server's
// additive_score_audio (server/matchmaker_service.py) -- each note as 8 harmonics weighted 1/h, a
// 5 ms attack, a 1 s exponential decay and a 30 ms release, peak-normalized, padded to the first
// onset and cut 0.1 s after the last onset.
//
// Timing is partitura's performance_notearray_from_score_notearray with a per-note bpm of
// tempo x beat_type / 4, so every quarter note lasts 60 / tempo seconds whatever the meter. It is
// reproduced down to partitura's float32 storage: note positions are kept as float32 *beats* (a
// beat is an eighth in 6/8, a half in 2/2), onset gaps are float32 differences of those, and the
// resulting seconds are stored as float32. Exact quarters would move a note's first sample by
// one now and then -- harmless, but then this wouldn't be the server's reference.

export interface ReferenceNote {
  pitch: number; // MIDI
  onsetQuarter: number; // bar 1's downbeat is 0; a pickup is negative
  durationQuarter: number;
}

// Time signatures in force, by position (as scoreNotes returns them).
export interface MeterSegment {
  startQuarter: number;
  beatType: number;
}

export interface ReferenceTiming {
  meter: MeterSegment[];
  quarterOrigin: number; // the score's start (negative with a pickup)
}

const HARMONICS = 8;
const DECAY_SECONDS = 1.0;
const fround = Math.fround;

// partitura's beat_map / inv_beat_map in quarter terms: piecewise linear, beat 0 at quarter 0.
function beatMaps(meter: MeterSegment[]): { beat: (q: number) => number; quarter: (b: number) => number; beatTypeAt: (q: number) => number } {
  const segs = (meter.length ? [...meter] : [{ startQuarter: 0, beatType: 4 }]).sort((a, b) => a.startQuarter - b.startQuarter);
  // Beat value at each segment start, anchored so that quarter 0 is beat 0.
  const beatAt: number[] = [];
  let zeroSeg = 0;
  for (let i = 0; i < segs.length; i += 1) if (segs[i].startQuarter <= 0) zeroSeg = i;
  beatAt[zeroSeg] = -segs[zeroSeg].startQuarter * (segs[zeroSeg].beatType / 4);
  for (let i = zeroSeg + 1; i < segs.length; i += 1) beatAt[i] = beatAt[i - 1] + (segs[i].startQuarter - segs[i - 1].startQuarter) * (segs[i - 1].beatType / 4);
  for (let i = zeroSeg - 1; i >= 0; i -= 1) beatAt[i] = beatAt[i + 1] - (segs[i + 1].startQuarter - segs[i].startQuarter) * (segs[i].beatType / 4);
  const segOfQ = (q: number) => {
    let s = 0;
    for (let i = 0; i < segs.length; i += 1) if (segs[i].startQuarter <= q) s = i;
    return s;
  };
  const segOfB = (b: number) => {
    let s = 0;
    for (let i = 0; i < segs.length; i += 1) if (beatAt[i] <= b) s = i;
    return s;
  };
  return {
    beat: (q) => {
      const s = segOfQ(q);
      return beatAt[s] + (q - segs[s].startQuarter) * (segs[s].beatType / 4);
    },
    quarter: (b) => {
      const s = segOfB(b);
      return segs[s].startQuarter + (b - beatAt[s]) / (segs[s].beatType / 4);
    },
    beatTypeAt: (q) => segs[segOfQ(q)].beatType
  };
}

export function referenceAudio(notes: ReferenceNote[], tempo: number, sampleRate: number, timing: ReferenceTiming = { meter: [], quarterOrigin: 0 }): Float32Array {
  if (notes.length === 0) return new Float32Array(0);
  const maps = beatMaps(timing.meter);

  // note_array: onset/duration in beats, float32.
  const rawBeats = notes.map((n) => fround(maps.beat(n.onsetQuarter)));
  const durBeats = notes.map((n) => fround(maps.beat(n.onsetQuarter + n.durationQuarter) - maps.beat(n.onsetQuarter)));
  // additive_score_audio: `if min(onset_beat) <= 0: onset_beat += min(onset_beat)`.
  const minBeat = Math.min(...rawBeats);
  const beats = minBeat <= 0 ? rawBeats.map((b) => fround(b + minBeat)) : rawBeats;
  // Per-note bpm: tempo x beat_type / 4 of the time signature in force at inv_beat_map(beat).
  const bpm = beats.map((b) => (tempo * maps.beatTypeAt(maps.quarter(b))) / 4);
  // interp1d(kind="previous") over (beat, bpm): the bpm of the last note at or before x.
  const order = beats.map((b, i) => i).sort((a, b) => beats[a] - beats[b] || a - b);
  const bpmAt = (x: number): number => {
    let value = bpm[order[0]];
    for (const i of order) {
      if (beats[i] <= x) value = bpm[i];
      else break;
    }
    return value;
  };
  const unique = [...new Set(order.map((i) => beats[i]))];
  const uniqueSec = new Map<number, number>();
  let acc = 0;
  unique.forEach((u, k) => {
    if (k > 0) acc += fround(u - unique[k - 1]) * (60 / bpmAt(unique[k - 1]));
    uniqueSec.set(u, acc);
  });
  const onsets = beats.map((b) => fround(uniqueSec.get(b) as number));
  const durations = beats.map((b, i) => fround((60 / bpmAt(b)) * durBeats[i]));
  const offsets = onsets.map((o, i) => fround(o + durations[i]));

  const maxOffset = Math.max(...offsets);
  const audio = new Float64Array(Math.ceil(maxOffset * sampleRate) + 1);
  const releaseSamples = 0.03 * sampleRate;
  notes.forEach((note, i) => {
    // The server's numpy (1.26) multiplies a float32 scalar by an int in float64, then int() truncates.
    const start = Math.trunc(onsets[i] * sampleRate);
    const length = Math.max(1, Math.trunc(fround(offsets[i] - onsets[i]) * sampleRate));
    const f0 = 440 * 2 ** ((note.pitch - 69) / 12);
    const end = Math.min(audio.length, start + length);
    for (let s = start; s < end; s += 1) {
      const k = s - start;
      const t = k / sampleRate;
      let tone = 0;
      for (let h = 1; h <= HARMONICS; h += 1) {
        if (h * f0 >= sampleRate / 2) break;
        tone += (1 / h) * Math.sin(2 * Math.PI * h * f0 * t);
      }
      const envelope = Math.min(1, t / 0.005) * Math.exp(-t / DECAY_SECONDS) * Math.min(1, (length - k) / releaseSamples);
      audio[s] += tone * envelope;
    }
  });

  let peak = 0;
  for (let s = 0; s < audio.length; s += 1) peak = Math.max(peak, Math.abs(audio[s]));
  const scale = peak > 0 ? 1 / peak : 1;
  // Pad to the first onset and cut 0.1 s after the last, both measured from the score's start.
  const secondsPerQuarter = 60 / tempo;
  const firstOnset = maps.quarter(Math.min(...rawBeats)) - timing.quarterOrigin;
  const lastOnset = Math.max(...notes.map((n) => n.onsetQuarter)) - timing.quarterOrigin;
  const pad = Math.trunc(firstOnset * secondsPerQuarter * sampleRate);
  const total = Math.min(pad + audio.length, Math.trunc((lastOnset * secondsPerQuarter + 0.1) * sampleRate));
  const out = new Float32Array(Math.max(0, total));
  for (let s = pad; s < out.length; s += 1) out[s] = audio[s - pad] * scale;
  return out;
}

// Reference frame -> score position in quarters (the server's ref_frame_to_beat, then beat ->
// quarter): frame i sits at i / frameRate seconds after the score's start.
export function refFrameQuarters(frames: number, frameRate: number, tempo: number, quarterOrigin = 0): Float64Array {
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = quarterOrigin + (i / frameRate) * (tempo / 60);
  return out;
}
