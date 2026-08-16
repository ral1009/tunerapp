# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Sheet Music Tuner: a violin-first practice app. The user uploads sheet music, the app identifies the notes, and while the user plays through the piece the app listens and tracks intonation against the *expected* note (score-following) rather than acting as a generic tuner. Full product rationale and phased feature roadmap live in `sheet-music-tuner-plan.md` (condensed to a short working-contract pointer at `.github/copilot-instructions.md` for Copilot — not a full mirror). Key rules from that contract that still apply:

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
- The **OMR microservice** (`server/main.py`) is a standalone Python FastAPI process. It has no code sharing with the TS side — the contract between them is purely the HTTP JSON shape of `POST /api/parse-sheet` (see below). Its CORS allowlist must match the Vite dev server's actual origin/scheme (`server/main.py`'s `allow_origins` vs. `vite.config.ts`'s forced `https://localhost:5173` — these have drifted out of sync before; check both when touching either). `_extract_notes_from_musicxml` filters to a single `<voice>`, mirroring `score/musicxmlImport.ts`'s voice-filtering — keep these two in sync if that convention changes, same as the pitch-string-format rule below. homr's subprocess timeout is configurable via the `HOMR_TIMEOUT_SECONDS` env var (default 60s); failures are logged server-side (stdout/stderr, tracebacks) but not echoed to the client response.

### Live tuner pipeline (`audio/`)
`audio/captureModule/index.ts` (`BrowserMicrophoneCaptureController`) is the only runtime consumer of the pitch detector, and the only thing `src/App.tsx` talks to for live tuning. Flow: `getUserMedia` → `AudioWorkletNode` → a ~500ms auto-calibration phase (aggregates ambient noise RMS via median, not mean, so one transient loud sample can't skew the threshold, to set `silenceRmsThreshold` and a gain scalar) → framing (`frameSize`/`hopSize`) → `preprocessFrame` (`audio/preprocessing.ts`: biquad band-pass *then* noise gate — filtering first so out-of-band noise can't inflate the gate's RMS reading — then a Hann window) → `PitchDetector.detect()` (`audio/pitchDetector.ts`). A liveness watchdog restarts the whole pipeline if the worklet stops posting messages entirely for ~4s while listening/calibrating (reset on every message received, regardless of loudness) — deliberately decoupled from signal RMS, since gating it on "quiet" used to fire on ordinary silent practice pauses while missing the actual stuck-worklet case it's meant to catch.

`PitchDetector` is a hybrid, not a single algorithm: primary estimate from `pitchfinder`'s YIN, a hand-rolled normalized-autocorrelation search as fallback (or as the primary path when an `expectedFrequencyHz` hint narrows the search window — this hint mechanism is what future score-following work would drive), a difference-function heuristic to catch octave-halving errors in the 350–600Hz band, and a rolling median smoother. Confidence is computed separately via normalized cross-correlation at the detected lag.

`audio/onsetDetector.ts` (`OnsetDetector`, spectral-flux based) is wired into `audio/captureModule/index.ts`, which emits `onsetDetected` on every live frame; `practice/cursor.ts`'s `ScoreFollower` consumes it to advance the score cursor per detected onset. This wiring is early-stage and not yet validated as working well against real playing — see `sheet-music-tuner-plan.md` §11 for current status.

### Sheet music import → render pipeline (`score/`)
Two import paths normalize into the same `ScoreDocument` (`score/schema.ts`):
- `score/musicxmlImport.ts` (`importMusicXmlToScore`) parses a MusicXML string directly via `DOMParser`, walking each `<measure>`'s children in document order. It tracks `divisions`/key/time-signature/tempo as running state, handles `<backup>`/`<forward>` (multi-voice cursor repositioning), filters notes to a single `<voice>` (the app tracks one melodic line — a second voice/layer in the source is intentionally dropped), and skips grace notes (no `<duration>`, would otherwise count as a phantom quarter note).
- `score/omrImport.ts` (`importPhotoToScore`) POSTs image bytes to the Python server's `/api/parse-sheet`, then delegates the returned `xmlData` to `importMusicXmlToScore` rather than building a score from the flat `notes`/`frequencies` arrays in the response (those two arrays aren't reliably the same length — the server filters unparseable frequencies out of `frequencies` without touching `notes` — so don't zip them by index). `OmrImportResult` also carries the raw `xmlData` string alongside the parsed `score`, both for the renderer (see below) and so `App.tsx` can offer it as a MusicXML download.

**Per-measure signature changes**: `ScoreMeasure` optionally carries its own `timeSignature`/`keySignature`/`tempoBpm`, set only on the first measure and wherever a change actually occurs (not every measure). `ScoreDocument`'s top-level `timeSignature`/`keySignature`/`tempoBpm` are just the *starting* values (mirrors of `measures[0]`'s), not a piece-wide constant. This still matters for any code reading `ScoreDocument` directly (metadata display, future score-following), but no longer affects rendering — see below. `tempoBpm` is `number | null` — `null` means the source genuinely never specified a tempo, as opposed to a real authored value; `musicxmlImport.ts` used to fabricate `120` in that case, which is why this is nullable rather than defaulting.

`score/renderer/index.ts` (`renderScore(xmlData, container) → Promise<RenderedScoreHandle>` with `.unmount()`) renders directly from the raw MusicXML text via **OpenSheetMusicDisplay (OSMD)**, not from `ScoreDocument`. This replaced a hand-rolled VexFlow path that built one `StaveNote` per `ScoreNote` from the lossy `ScoreDocument` reduction — `ScoreDocument`/`musicxmlImport.ts` drops rests entirely (a rest advances the measure's beat position but is never added as a tickable), so any real piece with rests underfilled its VexFlow `Voice` relative to the time signature, producing exactly the overlapping/misaligned notation that used to show up here. `ScoreNote` also has no fields for ties, slurs, articulations, or dynamics, so the old renderer could never draw them regardless of engine. OSMD sidesteps all of this by parsing the source XML itself — `ScoreDocument` remains the internal model for metadata display and future score-following/cursor work, but is no longer in the rendering path at all. `renderScore` is async now (`osmd.load()` returns a `Promise`); callers must guard against the effect re-running before `load()` resolves.

**Beaming**: `score/renderer/beamGrouping.ts` (`applyAutomaticBeaming`) computes beam groups itself from each measure's actual time signature and writes `<beam>` elements directly into the XML before OSMD parses it, rather than relying on OSMD's `autoBeam` option. This isn't a style choice — direct testing (hand-built fixtures rendered through the real pipeline) found OSMD's own default automatic beam grouping **fails outright on a repeating pitch pattern** (a repeating 3-note phrase in 12/8 rendered completely unbeamed; an otherwise-identical varied-pitch phrase beamed correctly), reproducing regardless of key signature, `divisions` scale, or MusicXML version/DOCTYPE. "Send in the Clowns"' opening motif is exactly a repeating 3-note phrase, which is why it reliably triggered this — **don't re-attempt an `autoBeam`-only fix**, it's been ruled out against real data, not just theorized. `applyAutomaticBeaming` handles compound vs. simple meters, mid-piece meter changes (recomputed fresh per measure), multi-level beams with standard hook placement for 16th/32nd runs, and stops groups at rests/non-beamable notes/voice changes/measure boundaries; it does not account for tuplet `<time-modification>` ratios or grace notes (both pre-existing, intentional scope boundaries). Stem direction is *not* hand-computed — `renderScore` sets `setWantedStemDirectionByXml: false`, and OSMD/VexFlow's automatic stem computation is beam-aware, so it enforces one consistent direction per group on its own once `<beam>` data correctly groups the notes.

**Title/composer detection**: `musicxmlImport.ts`'s `resolveTitle`/`resolveComposer` rank every `<credit>` element on the page (not just `<work-title>`) — excluding parenthetical text, arranger/rights-org boilerplate, anything matching a part name or an `<identification><creator>` name, and very short fragments — then pick the largest-font-size survivor (`credit-type="title"` wins outright if present). This exists because HOMR's own OCR/text-region detection is unreliable at the source, confirmed against 3 real test scans: it has picked a part label ("Violin 1", OCR-garbled to "ionlin1"), a truncated fragment of the real title ("STRINGS" → "Trings"), and a small rights-org credit ("(ASCAP)") instead of the actual printed title. **This heuristic is a best-effort mitigation, not a fix for HOMR's OCR accuracy** — it can only rank/filter candidates HOMR actually produced, so a case where HOMR never captured the correct text anywhere in its output (the "Trings" case) can't be recovered this way. A more robust fix (sending the source photo to a vision-capable model for a dedicated title read) was deferred — worth revisiting if this keeps coming up. The resolved title/composer are also injected into the XML given to OSMD (`renderScore`'s `titleOverride`/`composerOverride` → `applyMetadataOverrides` in `score/renderer/index.ts`, via OSMD's `onXMLRead` hook) so the rendered score and the metadata card never disagree.

Pitch strings are formatted consistently as `<Step><#|b|><Octave>` (e.g. `C#4`, `Bb3` — single accidental only, no double sharps/flats) across two independent implementations that need to stay in sync if this convention changes: `server/main.py`'s `_note_name_to_frequency` and `score/musicxmlImport.ts`'s `pitchToNoteName`. (`score/renderer/index.ts` no longer has its own pitch-parsing regex — OSMD reads `<pitch>` elements straight from the XML.)

`score/correctionUI/index.ts` has one real function (`applyCorrection`, patches pitch/duration on notes by id) but no actual UI — it's a data-layer stub, not wired to any component.

### Score-following + practice review (`practice/`)
`practice/cursor.ts` (`ScoreFollower`) and `practice/reviewSummary.ts` (`summarizePracticeSession`) are implemented and wired into `App.tsx`: `ScoreFollower` consumes live capture frames (including `onsetDetected`) plus the `ScoreCursor` from `score/renderer` to advance through the score note-by-note, tracks median cents-off per note, and produces a per-note history that `reviewSummary.ts` reduces into a post-session summary (out-of-tune note count, average cents error) shown in `App.tsx`. This is wired but early-stage — not yet validated as reliable against real playing.

### Placeholder modules
`practice/metronome.ts`, `practice/spotPractice.ts`, `practice/streak.ts`, and `storage/db.ts` are still minimal interface/stub files (10–15 lines each) — typed contracts for future features (a tempo-synced metronome, spot-practice looping, practice streak tracking, an `expo-sqlite` adapter for the eventual React Native shell), not yet consuming any real data or wired into `App.tsx`.

### UI
`src/App.tsx` is the only React component in the app (no `components/`/`hooks/` directories exist) — plain `useState`/`useRef`, inline `CSSProperties` style objects in a `styles` const, dark card-based visual theme. It has two independent sections: the live tuner (drives `captureModule`) and the sheet-music import card (drives `omrImport` → `renderer`) — they don't share state.
