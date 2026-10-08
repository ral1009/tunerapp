const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export interface NoteReading {
  name: string; // "D", "F♯"
  octave: number;
  midi: number;
  cents: number; // from the nearest equal-tempered note at the given reference pitch
}

export function nearestNote(frequencyHz: number, referenceA4 = 440): NoteReading {
  const exact = 69 + 12 * Math.log2(frequencyHz / referenceA4);
  const midi = Math.round(exact);
  return { name: NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, midi, cents: (exact - midi) * 100 };
}

export function frequencyOf(midi: number, referenceA4 = 440): number {
  return referenceA4 * Math.pow(2, (midi - 69) / 12);
}

// The violin's open strings, low to high.
export const OPEN_STRINGS = [
  { name: 'G', midi: 55 },
  { name: 'D', midi: 62 },
  { name: 'A', midi: 69 },
  { name: 'E', midi: 76 },
] as const;

export function centsFrom(frequencyHz: number, targetMidi: number, referenceA4 = 440): number {
  return 1200 * Math.log2(frequencyHz / frequencyOf(targetMidi, referenceA4));
}

// An open string within this many cents counts as in tune: well under what an ear notices on an
// open string, and wide enough that a reading hovering near the line doesn't flicker.
export const IN_TUNE_CENTS = 5;

// Plain-language tuning advice for an open string.
export function tuningAdvice(cents: number): string {
  const size = Math.abs(cents);
  if (size <= IN_TUNE_CENTS) return 'in tune';
  if (size > 35) return cents < 0 ? 'well flat — bring the peg up a little' : 'well sharp — ease the peg down a little';
  return cents < 0 ? 'a touch flat — turn the fine tuner gently clockwise' : 'a touch sharp — turn the fine tuner gently anticlockwise';
}
