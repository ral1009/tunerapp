# Offline Validation Harness

This directory contains the Phase 0 acceptance test harness for pitch detection and onset detection.

## Expected files

- `dataset/`: one `.wav` file per test clip
- `ground-truth.json`: metadata describing expected note, steady-state window, rest windows, and (for onset-focused clips) expected onset timestamps

Copy `ground-truth.example.json` to `ground-truth.json` and fill in your real clips.

A clip can be pitch-accuracy-only (`expectedNote`/`expectedFrequencyHz`/`steadyStartMs`/`steadyEndMs`, as before), onset-only (`expectedOnsetsMs`, no pitch fields — a multi-note sequence has no single "expected note"), or both. `npm run phase0:generate-synthetic` can produce onset-only clips via `generateSynthetic.ts`'s `"sequence"` (a run of distinct, separately-attacked notes with exactly-known onset timestamps) and `"noise"` (pure background noise, no tonal content) definition kinds — prefer these over hand-splicing/crossfading real recordings for onset ground truth, since real clips have inconsistent lead-in silence and manual crossfades introduce their own artifacts that don't reflect real onset timing.

## Run

```bash
npm run phase0:validate
```

## Acceptance criteria checks

- >=95% frame-level note accuracy inside each clip's steady-state range
- <=1 octave error across entire dataset
- rest windows emit `no note` and do not produce spurious pitch
- pitch-stabilization latency <=150ms for first stable, correct detection after a note begins (this is a `PitchDetector`-only proxy, not a measurement of `OnsetDetector`)
- onset recall >=90% across gating onset fixtures (a detected onset within tolerance of each expected note attack)
- <=1 spurious onset detection outside designated rest windows across gating onset fixtures
- 0 spurious onset detections inside designated rest windows
- (diagnostic only, not gated) very-fast-sequence onset recall — mechanically capped by `OnsetDetector`'s `minOnsetIntervalMs` debounce floor regardless of `fluxThreshold`, tracked separately pending future debounce tuning

### Scope boundary for onset checks

These checks exercise `OnsetDetector.detect()` in isolation, with the same windowing production uses (a band-passed, fixed-size tail window of the larger pitch-analysis frame — see `audio/captureModule/index.ts`). They do **not** model the full compound gate that actually reaches `ScoreFollower` in production (`onsetResult.onset && rawRms >= calibratedSilenceRmsThreshold && detection.frequencyHz !== null` in `audio/captureModule/index.ts`, plus a further semitone-match gate in `practice/cursor.ts`). A passing gate here means the raw flux detector itself is behaving; it does not guarantee end-to-end score-following correctness, since the RMS/pitch-confidence gate depends on per-device calibration that this offline harness doesn't reproduce.