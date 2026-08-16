# Sheet Music Tuner — Project Plan (v2)

**Instrument:** Violin only for v1
**Platform:** Native mobile (iOS/Android), React Native + Expo (bare workflow)
**Sheet music input:** Photo/PDF (OMR) and MusicXML import, both converging on one internal score format
**Pitch detection:** Full restart — the previous (Ledger) implementation failed almost completely and should not be reused as-is
**Scope:** Full feature set planned; build in phases, cut scope per-phase as needed

This document is written to be handed to an AI coding assistant (e.g. GitHub Copilot) as a build spec. Each phase has concrete acceptance criteria so progress can be checked objectively rather than "it seems to work."

---

## 0. How to use this with GitHub Copilot

- **Stack this implies:** TypeScript + React Native (Expo bare workflow) for the app; Swift (iOS) and Kotlin (Android) for the native audio module in Phase 0 — this is the one part that isn't plain TypeScript, and it matters, since a managed/JS-only audio API is likely part of what broke Ledger; Node.js (or Python) for the offline pitch-detection validation script; SQL via `expo-sqlite` for storage.
- **Put this file where Copilot will actually see it.** Either drop it in the repo root and reference it in chat with `#file:sheet-music-tuner-plan.md`, or — better for ongoing use — save it as `.github/copilot-instructions.md` so Copilot pulls it into context automatically on every chat and inline suggestion in the repo, not just when pasted once.
- **Work through it one phase at a time**, not all at once. Start with: "Here's the project plan. Let's build Phase 0 only — set up the repo structure from §8, then the audio capture module and preprocessing pipeline from §5." Phase 0 specifically has a hard validation gate (§5's acceptance criteria) that should be passed before asking Copilot to touch Phase 1.

---

## 1. Why the restart on pitch detection

Ledger's tuner failed in essentially every way an audio pipeline can fail: notes rarely detected at all, wrong notes when something was detected, jumpy/unstable readings even on a held steady note, and heavy false-triggering from background noise. This pattern points to the *pipeline* being broken (buffering, preprocessing, thresholds), not just the algorithm choice — a correct YIN implementation with no signal conditioning around it would still behave close to this badly. The plan below fixes this by:

1. Using a well-tested pitch-detection library as the DSP core instead of a hand-rolled algorithm, so bugs aren't reinvented.
2. Adding mandatory signal preprocessing (noise gate, band-pass filter, windowing, confidence thresholding) that was likely missing or broken before.
3. Validating the pipeline **offline against recorded audio with known ground truth**, before it is ever wired into a live UI. This is the single biggest process change — testing pitch detection live inside a growing app made it impossible to isolate whether the algorithm, the audio pipeline, or the UI was the problem.

---

## 2. Recommended Tech Stack

| Layer | Choice | Why |
|---|---|---|
| App framework | React Native + Expo (bare workflow) | Bare workflow is required for low-level native audio access; Expo tooling still speeds up everything else |
| Audio capture | Native module for raw PCM buffer access — iOS `AVAudioEngine` tap, Android `AudioRecord` | Managed/high-level audio APIs (including Expo's default `expo-av`) do not reliably expose raw buffers at low enough latency for pitch tracking; this was likely part of what broke Ledger |
| Pitch detection core | A tested library, e.g. `pitchfinder` (npm) which implements YIN, AMDF, Macleod, Dynamic Wavelet — pick one and validate it, don't write it from scratch | Removes "did I implement YIN correctly" as a variable |
| Signal preprocessing | Custom, but small and testable: RMS-based noise gate, band-pass filter (~180 Hz–3.5 kHz, covers violin G3 open string through high positions), Hann windowing | Prevents background noise and out-of-range noise from ever reaching the pitch detector |
| MusicXML parsing | `musicxml-interfaces` or a small custom parser (pitch, duration, measure, voice only — no need for full spec coverage) | MuseScore exports standard MusicXML |
| Score rendering | OpenSheetMusicDisplay (OSMD) in a WebView, or VexFlow for tighter native control | Both photo-import and MusicXML-import converge on the same internal format and are rendered through this one clean typeset renderer — no more "overlay on a photo" approach |
| OMR (photo → notes) | VLM call → structured JSON note list → internal score format (see §4) | Model choice TBD by benchmark, see §4 |
| Local storage | SQLite (`expo-sqlite`) | Scores, annotations, fingerings, practice history — all local for v1 |
| Offline DSP testing | Node.js script or Python, run against recorded `.wav` samples | Used only in development, to validate the pitch pipeline before it touches the app — see §5 |

---

## 3. Core Data Model

Both import paths (photo and MusicXML) normalize into this single format. Nothing downstream (tuner engine, cursor, annotations) should ever need to know which import path a score came from.

```json
{
  "title": "string",
  "composer": "string",
  "tempoBpm": 96,
  "keySignature": "D major",
  "timeSignature": "4/4",
  "sourceType": "musicxml | photo",
  "measures": [
    {
      "index": 0,
      "notes": [
        {
          "id": "m0-n0",
          "pitch": "A4",
          "startBeat": 0,
          "durationBeats": 1,
          "fingering": null
        }
      ]
    }
  ],
  "annotations": [],
  "practiceHistory": []
}
```

Note: bounding-box coordinates from the OMR step are only needed transiently during the correction step (§4b) to let the user tap a note in the source photo and compare it against the reprinted version — they are not part of the long-term stored score, since the score is always rendered cleanly from this JSON, never as a photo overlay.

---

## 4. Sheet Music Input Pipelines

### 4a. MusicXML import
Parse directly into the schema above. Build and validate this path first — it lets every other part of the app (renderer, tuner, cursor) be developed and tested against a reliable score source before OMR is introduced.

### 4b. Photo/PDF import (OMR → clean reprint → light correction)
1. User photographs or uploads sheet music.
2. Image sent to a VLM with a structured-output prompt requesting every note in reading order: pitch, duration, measure number, plus its bounding box in image coordinates (bounding boxes used only for the correction step below).
3. Result normalized into the internal score schema.
4. **The score is immediately re-rendered cleanly** through the same OSMD/VexFlow pipeline used for MusicXML — the user never has to read the raw photo again. This directly answers the "make it look clean, not like a phone photo" requirement.
5. **Lightweight correction step**, shown right after the clean reprint:
   - Tap any note to open a small popup: pitch stepper, duration selector.
   - A simple toolbar to add or delete a note.
   - A simple key signature / time signature picker (dropdown-style, not a full properties panel).
   - This is explicitly **not** a full notation editor — no drag-to-reposition, no multi-voice editing, no slurs/articulations/dynamics editing. The goal is "fix what OMR got wrong in under a minute," not "edit music."
6. Once confirmed, the score is stored. An **export to MusicXML** action is available from the score's menu (not part of the required flow) so a real MuseScore-compatible file can be produced on demand.

**Model comparison to benchmark before committing (do this before writing pipeline code):**
- GPT-4o-class / Gemini-class VLMs, general-purpose but strong at structured JSON extraction
- Qwen-VL, worth comparing for cost if accuracy is close
- Purpose-built OMR models (Audiveris, oemer) — trained specifically on music notation, may outperform a general VLM on this narrow task
- Build a small hand-labeled benchmark set (10-15 real violin sheet music photos of varying quality) and score note-level accuracy for each candidate before picking one.

---

## 5. Pitch Detection — Rebuilt From Scratch (Phase 0)

This is the first thing to build, in isolation, before any app UI. Do not integrate this into the app until it passes the acceptance criteria below.

**Pipeline, in order:**
1. Raw PCM buffer captured via native audio module (target: ~2048-sample buffers, 44.1kHz, adjust based on latency testing)
2. RMS amplitude check — if below a silence threshold, emit "no note" and skip the rest of the pipeline (this directly targets the "background noise triggered it" and "nothing detected" failures — a proper gate should reduce both)
3. Band-pass filter limiting the signal to ~180 Hz–3.5 kHz (violin's practical fundamental range plus some headroom)
4. Hann window applied before pitch estimation
5. Pitch estimation via the chosen library (YIN or similar), constrained to a search window centered on the *expected* note's frequency (±3 semitones) once score-following is wired in — this reuses the good idea from Ledger, just implemented on a solid foundation this time
6. Confidence/clarity value from the algorithm checked against a threshold — below threshold, emit "no note" rather than guessing (this directly targets the "wrong note" and "jumpy" failures)
7. Median smoothing over the last few frames before emitting a final pitch reading

**Offline validation methodology (do this before any live testing):**
1. Record a small dataset: open strings (G, D, A, E), then 8-10 fingered notes across first through third position, each held steady for ~2 seconds, in a normal room (not a silent studio — some ambient noise should be present intentionally).
2. Run the full pipeline above against these recordings via a Node/Python script, comparing detected pitch to known ground truth.
3. **Acceptance criteria before moving to Phase 1:**
   - Correct pitch (right note name) detected on ≥95% of frames during the steady part of each held note
   - No more than one octave error across the entire test set
   - Silence/rest segments between notes correctly emit "no note" rather than a spurious pitch
   - Latency from note onset to first stable correct reading is under ~150ms (adjust based on what feels usable once tested live)
4. Only once these pass on recorded audio should the pipeline be wired into a live mic input and tested by actually playing.

---

## 6. Score-Following

Once Phase 0's pitch detection is validated, the app needs to know *which* note in the score to check the live pitch against.

**Approach: onset-detection cursor.** Detect the onset of each new note the player plays (using an amplitude/spectral-flux onset detector, separate from the pitch estimator itself), and advance the score cursor by one note per detected onset. This is forgiving of tempo drift, unlike a pure time-based/metronome cursor, and is a manageable scope for v1 (full DTW-style alignment that tolerates skipped or repeated passages is a post-v1 research spike, not a requirement now).

Bowed-string onsets are softer than plucked or percussive onsets — validate onset detection specifically against violin recordings (not synthetic test tones) as part of the Phase 0 offline testing, since this is a plausible new failure point.

---

## 7. Feature Breakdown by Phase

### Phase 0 — Pitch detection foundation (build and validate in isolation first)
- Native raw audio capture module
- Preprocessing pipeline (noise gate, band-pass, windowing)
- Pitch estimation with confidence thresholding and median smoothing
- Offline validation script against recorded ground-truth audio
- Must pass acceptance criteria in §5 before Phase 1 begins

### Phase 1 — Core MVP
- MusicXML import → internal score format → OSMD/VexFlow rendering
- Photo import → OMR → internal score format → clean reprint → lightweight correction UI (§4b)
- Wire the validated Phase 0 pitch pipeline into onset-detection score-following
- Real-time in-tune/out-of-tune indicator next to the score (not a full-screen tuner)
- Basic metronome, synced to the score's tempo marking

### Phase 2 — Ear training & review
- "Hide tuner" mode: no live numeric feedback, just a subtle color cue or a reference drone played when off-pitch, to build ear training instead of screen dependence
- Practice Review: post-session summary of consistently out-of-tune notes, shown on the score
- Fingering annotation: tap a note, assign a finger number, persists with the score

### Phase 3 — Practice tools
- Markup layer: pen/highlighter freehand annotation on the score
- Spot Practice: select a bar range, loop it, track accuracy per repetition
- Practice Streak: local calendar/stats tracking consistency

---

## 8. Suggested Repo Structure

```
/audio
  captureModule (native, iOS + Android)
  preprocessing.ts   (noise gate, band-pass, windowing)
  pitchDetector.ts   (wraps chosen library + confidence thresholding + smoothing)
  onsetDetector.ts
  __tests__/offline-validation/  (recorded .wav samples + ground truth + test script)
/score
  schema.ts          (the data model in §3)
  musicxmlImport.ts
  omrImport.ts        (VLM call + normalization)
  renderer/           (OSMD or VexFlow integration)
  correctionUI/        (lightweight editing screen from §4b)
/practice
  cursor.ts           (score-following, wired to onsetDetector + pitchDetector)
  metronome.ts
  reviewSummary.ts
  spotPractice.ts
  streak.ts
/storage
  db.ts               (SQLite setup)
```

---

## 9. Build Order (hand this to the coding assistant as a checklist)

1. **Phase 0, fully, in isolation.** Do not start on any UI or import pipeline until the offline validation acceptance criteria in §5 pass.
2. Score data schema + SQLite storage, tested with hand-written sample scores (no import pipeline needed yet).
3. MusicXML importer + OSMD/VexFlow rendering — get one real MuseScore export displaying correctly end-to-end.
4. Wire Phase 0's validated pitch pipeline + onset detection into a live score-following cursor, tested against the MusicXML-sourced score only (no OMR yet).
5. In-tune UI + metronome — this closes a fully working MusicXML-only MVP loop.
6. OMR pipeline: run the model benchmark (§4b), build the pipeline, build the clean-reprint + lightweight correction screen, plug into the same score schema used in step 2.
7. Phase 2 and Phase 3 features, once the core loop from steps 1-6 is solid and has actually been tested by playing violin against it.

---

## 10. Open Questions to Settle During Build

- Buffer size / sample rate tradeoffs for the native audio module will need real device testing — don't lock these in from research alone, tune them against the offline validation set in §5.
- Which pitch-detection library to standardize on (`pitchfinder`'s YIN vs. AMDF vs. another option) should be picked based on which performs best against the recorded validation set, not by default.
- Decide how much UI polish the correction screen (§4b) needs for v1 vs. treating it as functional-but-plain until the rest of the app is solid.

---

## 11. Progress Update & Mobile Transition Plan (v3 addendum, 2026-08-14)

The sections above (v2) were written before any code existed and assumed a native-mobile build from day one. In practice the actual build took a different, deliberate path: a fast-iterating Vite/React **web prototype** (`src/`, `audio/`, `score/`, `practice/`, `storage/` at the repo root) was built first, to de-risk the pitch pipeline, OMR integration, OSMD rendering, and score-following algorithm before committing to native mobile complexity. This addendum captures where that prototype actually stands and what "transition to mobile" concretely means from here. It supersedes v2's sequencing, not its underlying design decisions (data model, DSP approach, OMR pipeline) — those still hold.

### Status as of now

- **Phase 0 (pitch detection foundation): done and validated.** `npm run phase0:validate` gate passing.
- **Phase 1 core loop is wired end-to-end in code, but not yet working well.** MusicXML + photo import, OSMD rendering with automatic beaming, onset-detection score-following (`practice/cursor.ts`'s `ScoreFollower`, driven by `audio/onsetDetector.ts` now wired into `audio/captureModule/index.ts`), a live in-tune/out-of-tune indicator, and a post-session practice review summary (`practice/reviewSummary.ts`) all call into each other in `src/App.tsx`. That is a "wired" milestone, not a "working" one — it's early-stage and still needs real debugging/iteration against actual playing, not just a manual sign-off pass.
- **Fully unstarted on top of that**: the metronome (`practice/metronome.ts` is just a `msPerBeat` helper, not wired to anything) and the OMR lightweight correction screen (§4b — `score/correctionUI/index.ts` has the `applyCorrection` data function but no UI).
- The web-first pivot was effective, not a detour: the native capture-module stubs (`audio/captureModule/ios`, `/android`) and `storage/db.ts`'s explicit "wire expo-sqlite in Phase 1/2 app shell" comment show the eventual RN port was anticipated from the start, even while iterating on web.

### Gate before starting the mobile transition

The core loop must first be made to **actually work well** — validated by playing violin against a real imported piece end-to-end, not just wired code or a passing typecheck. This repo's existing philosophy (test suites verify correctness, not feature completeness) applies here too. **Phase 1.5 below does not start until this gate passes** — porting a loop that isn't working yet to a second platform would just double the debugging surface across two audio stacks at once.

### Phase 1.5 — Mobile Transition

Once the core loop gate passes, transition into an RN + Expo (bare workflow) app shell as a module-by-module port, not a rewrite:

1. Stand up the RN + Expo (bare workflow) app shell.
2. Port with little/no change — these are plain TypeScript with no DOM/Web-Audio coupling: `audio/pitchDetector.ts`, `preprocessing.ts`, `onsetDetector.ts`, `fft.ts`, `score/schema.ts`, `musicxmlImport.ts`, `omrImport.ts` (swap the base URL), `beamGrouping.ts`, `practice/cursor.ts`, `practice/reviewSummary.ts`.
3. Replace the Web Audio/`AudioWorklet` frame source in `audio/captureModule/index.ts` with the real iOS/Android native modules — wiring up the currently-unwired `audio/captureModule/ios` and `/android` stubs to actually capture raw PCM and feed it through the same frame pipeline — while keeping the same `MicrophoneCaptureController` interface so calling code doesn't change. **Build and validate Android first** (`audio/captureModule/android`, Kotlin/`AudioRecord`) on real hardware before starting iOS — bringing up native mic capture on both platforms at once would double the debugging surface the same way porting a not-yet-working core loop would.
4. Rebuild `score/renderer` as an OSMD-in-WebView bridge rather than a native rewrite: keep `beamGrouping.ts` and the OSMD parsing/metadata-override logic untouched inside the WebView, and add a thin message bridge so `ScoreCursor` (reset/advance/show/hide) still satisfies the interface `practice/cursor.ts`'s `ScoreFollower` already depends on. This preserves the already-solved beam-grouping bug fix and title/composer heuristic instead of re-discovering equivalent bugs in a from-scratch renderer.
5. Wire `storage/db.ts`'s `DatabaseAdapter` to `expo-sqlite` — already flagged as the explicit next step in that file's own comment.
6. Deploy `server/` (FastAPI + `homr`) somewhere reachable over HTTPS from a physical/simulator device, and update its CORS allowlist accordingly — it currently only runs as a local dev server, which a mobile device off the dev machine's network can't reach.
7. Rebuild the `App.tsx` UI as RN screens. This is the one large presentational rewrite; the underlying state logic (capture state machine, `ScoreFollower`, review summary) carries over unchanged — only the view layer is redone.
8. Acceptance gate: the same manual "play a real imported piece end-to-end" test, now on a physical device, plus a re-check of buffer size / sample rate assumptions on-device (already flagged as an open question in §10) since those were only tuned against desktop/web behavior.

### Revised phase order after the transition

All feature work from here is mobile-native — there's no more prototyping value in building anything new on web first, so the web prototype becomes a frozen reference once the mobile core-loop gate (step 8 above) passes, not a maintained parallel target:

- **Phase 1 close-out**: metronome wired to the score's tempo; OMR lightweight correction screen (§4b) built as a native RN screen.
- **Phase 2**: "Hide tuner" ear-training mode; fingering annotation. (Practice Review — §7 Phase 2's other item — already carries over working from web.)
- **Phase 3**: markup layer; Spot Practice loop; Practice Streak (`practice/streak.ts` is still a full stub — untouched since it was first scaffolded).
