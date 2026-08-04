# Sheet Music Tuner Working Contract

Use [sheet-music-tuner-plan.md](../sheet-music-tuner-plan.md) as the source of truth.

## Phase gate

- Do not start Phase 1 feature wiring until Phase 0 offline validation passes.
- Keep pitch detection pipeline changes measurable via `npm run phase0:validate`.

## Pipeline baseline

- Violin-only frequency focus: 180Hz to 3.5kHz.
- Emit `no note` for silence or low-confidence frames.
- Prefer correctness and stability over aggressive note guessing.

## Data model rule

- Both MusicXML and OMR import must normalize to the common score schema in `score/schema.ts`.