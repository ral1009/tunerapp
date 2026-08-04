# Sheet Music Tuner

Violin-first sheet music practice app built in phases from [sheet-music-tuner-plan.md](sheet-music-tuner-plan.md).

## Current status

- Phase 0 scaffolded in this repo
- DSP pipeline implemented in `audio/preprocessing.ts` and `audio/pitchDetector.ts`
- Offline validation harness implemented in `audio/__tests__/offline-validation`
- Native capture module currently stubbed for iOS/Android bridge wiring

## Project layout

- `audio/` Phase 0 DSP + capture/onset modules
- `score/` shared score schema + import/renderer/correction placeholders
- `practice/` cursor/metronome/review tools placeholders
- `storage/` DB adapter contract for future `expo-sqlite` integration

## Install

1. Install Node.js 20+.
2. Install dependencies:

```bash
npm install
```

## Phase 0 validation workflow

1. Copy `audio/__tests__/offline-validation/ground-truth.example.json` to `audio/__tests__/offline-validation/ground-truth.json`.
2. Record and add your `.wav` clips under `audio/__tests__/offline-validation/dataset`.
3. Fill clip metadata and ground-truth windows in `ground-truth.json`.
4. Run:

```bash
npm run phase0:validate
```

The validation script enforces the plan gate before Phase 1:

- steady-note accuracy >= 95%
- octave errors <= 1 across dataset
- rest windows emit no note (no false positives)
- mean onset latency <= 150ms

## Next build steps

1. Complete native PCM capture bridge in `audio/captureModule/ios` and `audio/captureModule/android`.
2. Tune preprocessing + confidence thresholds using real violin recordings until validation passes.
3. Start Phase 1 (`score/` import/rendering loop) only after Phase 0 gate is consistently green.