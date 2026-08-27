const EPSILON_QUARTER_NOTES = 0.02;
const CANDIDATE_BEAT_TYPES = [8, 4, 16, 2, 32];

// Infers a MusicXML time signature (beats/beat-type) that exactly fits a measure's actual total
// duration, for auto-correcting bars where the source (typically HOMR-derived) XML carried
// forward a stale/wrong time signature rather than encoding a real mid-piece meter change.
// Shared by score/musicxmlImport.ts (corrects the internal ScoreDocument model) and
// score/renderer/timeSignatureCorrection.ts (corrects the raw XML OSMD renders) so the two
// don't drift into disagreeing about what a given measure's meter should be.
//
// Inherently ambiguous: e.g. 3 quarter notes fits both 3/4 and 6/8 identically, since duration
// alone can't distinguish beat grouping. `preferredBeatType` (normally the currently active time
// signature's own beat-type) is tried first specifically to favor staying in the same meter
// family (compound vs. simple) the piece was already in, rather than always defaulting to a
// simple meter guess.
export function inferTimeSignature(actualQuarterNotes: number, preferredBeatType: number): { beats: number; beatType: number } | null {
  if (!Number.isFinite(actualQuarterNotes) || actualQuarterNotes <= 0) {
    return null;
  }

  const candidates = [preferredBeatType, ...CANDIDATE_BEAT_TYPES].filter(
    (value, index, all) => Number.isFinite(value) && value > 0 && all.indexOf(value) === index
  );

  for (const beatType of candidates) {
    const beats = (actualQuarterNotes * beatType) / 4;
    const roundedBeats = Math.round(beats);
    if (roundedBeats >= 1 && Math.abs(beats - roundedBeats) < EPSILON_QUARTER_NOTES) {
      return { beats: roundedBeats, beatType };
    }
  }

  return null;
}
