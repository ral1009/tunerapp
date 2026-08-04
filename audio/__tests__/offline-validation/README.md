# Offline Validation Harness

This directory contains the Phase 0 acceptance test harness for pitch detection.

## Expected files

- `dataset/`: one `.wav` file per test note clip
- `ground-truth.json`: metadata describing expected note, steady-state window, and rest windows

Copy `ground-truth.example.json` to `ground-truth.json` and fill in your real clips.

## Run

```bash
npm run phase0:validate
```

## Acceptance criteria checks

- >=95% frame-level note accuracy inside each clip's steady-state range
- <=1 octave error across entire dataset
- rest windows emit `no note` and do not produce spurious pitch
- onset latency <=150ms for first stable, correct detection