# Sheet Music Tuner Working Contract

Use [sheet-music-tuner-plan.md](../sheet-music-tuner-plan.md) as the source of truth.

## Phase gate

- Do not start Phase 1 feature wiring until Phase 0 offline validation passes.
- Keep pitch detection pipeline changes measurable via `npm run phase0:validate`.

## Mobile transition gate

- Do not begin Phase 1.5 (RN/Expo port) work until the core loop (import → render →
  live score-following → in-tune feedback) has been validated by actually playing
  violin against a real imported piece end-to-end — not just wired code or passing
  `npm run followerTest`/`typecheck`.
- As of this session, metronome-mode tracking is the mode that gates this — listening
  mode has been deprioritized after extensive live-testing didn't land reliably.
- See `sheet-music-tuner-plan.md` §11 for the full gate rationale and the Phase 1.5
  sequence once it's met.

## Pipeline baseline

- Violin-only frequency focus: ~80Hz to 3.5kHz.
- Emit `no note` for silence or low-confidence frames.
- Prefer correctness and stability over aggressive note guessing.

## Data model rule

- Both MusicXML and OMR import must normalize to the common score schema in `score/schema.ts`.