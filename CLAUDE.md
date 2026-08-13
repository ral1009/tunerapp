# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Sheet Music Tuner: a violin-first practice app. The user uploads sheet music, the app identifies the notes, and while the user plays through the piece the app listens and tracks intonation against the *expected* note (score-following) rather than acting as a generic tuner. Full product rationale and phased feature roadmap live in `sheet-music-tuner-plan.md` (mirrored at `.github/copilot-instructions.md` for Copilot). Key rules from that contract that still apply:

- Do not build out Phase 1 score/UI features in a way that regresses the Phase 0 pitch-detection gate — changes to the pipeline should stay measurable via `npm run phase0:validate`.
- Violin-only frequency focus: ~80Hz–3.5kHz. Prefer emitting "no note" over guessing on silence/low-confidence frames — correctness and stability over aggressive detection.
- Both the MusicXML import path and the OMR (photo) import path must normalize into the single shared `ScoreDocument` schema in `score/schema.ts`.

This repo is a **Vite/React web prototype**; the long-term target platform per the plan doc is React Native + Expo with native iOS (Swift/AVAudioEngine) and Android (Kotlin/AudioRecord) capture. `audio/captureModule/ios` and `audio/captureModule/android` are unwired native-bridge stubs for that future migration.

## Commands

Node/TypeScript side (repo root):
```bash
npm install               # Node 20+
npm run typecheck         # tsc --noEmit, covers audio/ score/ practice/ storage/ src/
npm run build              # tsc build
npm run dev:web            # Vite dev server at https://localhost:5173 (self-signed cert; HTTPS is forced because mic capture needs it)
npm run build:web          # production web build
npm run preview:web        # preview the production build
```

There is no unit test framework (no Jest/Vitest). Correctness for the pitch-detection pipeline is instead checked by an offline validation harness against recorded/synthetic `.wav` fixtures:
```bash
npm run phase0:generate-synthetic   # regenerate synthetic test tones into audio/__tests__/offline-validation/dataset
npm run phase0:validate             # run the acceptance gate (see audio/__tests__/offline-validation/README.md)
```
The gate checks: >=95% steady-state frame accuracy, <=1 octave error across the dataset, no spurious pitch on rest windows, and <=150ms mean onset latency. `ground-truth.json` and the `dataset/` directory are gitignored — copy `ground-truth.example.json` to `ground-truth.json` and add your own `.wav` clips locally.

Python side (`server/`) — a separate FastAPI microservice, not part of the Node toolchain:
```bash
cd server
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
It requires `uv`/`uvx` on PATH (used to invoke the `homr` optical-music-recognition CLI on demand — `uvx homr <image>` fetches and runs it without a separate install step). If `uv` was installed after the terminal running `uvicorn` was opened, that process still has the old PATH — restart the terminal (or the whole IDE, if it's an integrated terminal) before re-testing.

Both the Vite dev server and this Python server must be running simultaneously for the sheet-music-photo-import feature to work end-to-end.

## Architecture

### Two independent runtimes
- The **web app** (`src/`, `audio/`, `score/`, `practice/`, `storage/`) is TypeScript/React, built with Vite.
- The **OMR microservice** (`server/main.py`) is a standalone Python FastAPI process. It has no code sharing with the TS side — the contract between them is purely the HTTP JSON shape of `POST /api/parse-sheet` (see below). Its CORS allowlist must match the Vite dev server's actual origin/scheme (`server/main.py`'s `allow_origins` vs. `vite.config.ts`'s forced `https://localhost:5173` — these have drifted out of sync before; check both when touching either).

### Live tuner pipeline (`audio/`)
`audio/captureModule/index.ts` (`BrowserMicrophoneCaptureController`) is the only runtime consumer of the pitch detector, and the only thing `src/App.tsx` talks to for live tuning. Flow: `getUserMedia` → `AudioWorkletNode` → a ~500ms auto-calibration phase (measures ambient noise RMS to set `silenceRmsThreshold` and a gain scalar) → framing (`frameSize`/`hopSize`) → `preprocessFrame` (`audio/preprocessing.ts`: noise gate → biquad band-pass → Hann window) → `PitchDetector.detect()` (`audio/pitchDetector.ts`). A watchdog auto-restarts the whole pipeline after prolonged near-silence while "listening", to recover from stuck worklets/contexts.

`PitchDetector` is a hybrid, not a single algorithm: primary estimate from `pitchfinder`'s YIN, a hand-rolled normalized-autocorrelation search as fallback (or as the primary path when an `expectedFrequencyHz` hint narrows the search window — this hint mechanism is what future score-following work would drive), a difference-function heuristic to catch octave-halving errors in the 350–600Hz band, and a rolling median smoother. Confidence is computed separately via normalized cross-correlation at the detected lag.

`audio/onsetDetector.ts` (`OnsetDetector`, spectral-flux based) exists but is **not wired into `captureModule` or `App.tsx`** — it's a standalone module, not currently part of the live pipeline.

### Sheet music import → render pipeline (`score/`)
Two import paths normalize into the same `ScoreDocument` (`score/schema.ts`):
- `score/musicxmlImport.ts` (`importMusicXmlToScore`) parses a MusicXML string directly via `DOMParser`, walking each `<measure>`'s children in document order. It tracks `divisions`/key/time-signature/tempo as running state, handles `<backup>`/`<forward>` (multi-voice cursor repositioning), filters notes to a single `<voice>` (the app tracks one melodic line — a second voice/layer in the source is intentionally dropped), and skips grace notes (no `<duration>`, would otherwise count as a phantom quarter note).
- `score/omrImport.ts` (`importPhotoToScore`) POSTs image bytes to the Python server's `/api/parse-sheet`, then delegates the returned `xmlData` to `importMusicXmlToScore` rather than building a score from the flat `notes`/`frequencies` arrays in the response (those two arrays aren't reliably the same length — the server filters unparseable frequencies out of `frequencies` without touching `notes` — so don't zip them by index).

**Per-measure signature changes**: `ScoreMeasure` optionally carries its own `timeSignature`/`keySignature`/`tempoBpm`, set only on the first measure and wherever a change actually occurs (not every measure). `ScoreDocument`'s top-level `timeSignature`/`keySignature`/`tempoBpm` are just the *starting* values (mirrors of `measures[0]`'s), not a piece-wide constant. Any code that needs the *effective* signature at a given measure (the renderer does this) must walk forward from the start tracking the last-seen value — there's no single global signature valid for a whole piece. **Known open issue**: pieces with frequent meter/key changes still don't render correctly in `score/renderer/index.ts` end-to-end despite this — the per-measure plumbing is in place but something in the parse→render path is still producing overlapping/misaligned notation for such pieces. Worth re-verifying against the actual MusicXML (`xmlData` from the server response) rather than guessing further, if picked back up.

`score/renderer/index.ts` (`renderScore(score, container) → RenderedScoreHandle` with `.unmount()`) wraps VexFlow: one `Stave` per measure (wrapping into rows), one `StaveNote` per `ScoreNote` (chords are **not** grouped — simultaneous notes aren't expected for a single violin line, so this is an intentional simplification, not an oversight), auto-generated beaming. `beatsToVexDuration` snaps arbitrary `durationBeats` values to the nearest standard VexFlow duration (no tuplet notation, no ties across barlines).

Pitch strings are formatted consistently as `<Step><#|b|><Octave>` (e.g. `C#4`, `Bb3` — single accidental only, no double sharps/flats) across three independent implementations that all need to stay in sync if this convention changes: `server/main.py`'s `_note_name_to_frequency`, `score/musicxmlImport.ts`'s `pitchToNoteName`, and `score/renderer/index.ts`'s parsing regex in `buildVexNotes`.

`score/correctionUI/index.ts` has one real function (`applyCorrection`, patches pitch/duration on notes by id) but no actual UI — it's a data-layer stub, not wired to any component.

### Placeholder modules
`practice/` (`cursor.ts`, `metronome.ts`, `reviewSummary.ts`, `spotPractice.ts`, `streak.ts`) and `storage/db.ts` are all minimal interface/stub files (10–15 lines each) — typed contracts for future features (practice-session tracking, an `expo-sqlite` adapter for the eventual React Native shell), not yet consuming any real data or wired into `App.tsx`.

### UI
`src/App.tsx` is the only React component in the app (no `components/`/`hooks/` directories exist) — plain `useState`/`useRef`, inline `CSSProperties` style objects in a `styles` const, dark card-based visual theme. It has two independent sections: the live tuner (drives `captureModule`) and the sheet-music import card (drives `omrImport` → `renderer`) — they don't share state.
