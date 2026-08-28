# Sheet Music Tuner

Violin-first sheet music practice app built in phases from [sheet-music-tuner-plan.md](sheet-music-tuner-plan.md).

## Project Overview
Problems to address:
- Having both a tuner app and sheet music on a stand is inconvenient to the user, they must rapidly switch tabs or look at two places at once, making using a tuner while practicing very inconvenient 
- Current violin tuner apps are not very accurate with fast notes and sometimes imagine very high or low notes due to background noise
- Tuner apps cause users to develop bad habits and doesn’t help them train their ear, they become overreliant on the app and are unable to play without it. Trains their eyes to look at a screen instead of using their ears

Overview of App:
- An app where users can upload their sheet music and the notes are identified by the app. The app allows the user to play through the song by looking at the sheet music opened on the app, while the app listens to your playing and tracks your intonation.

Solutions:
- By having both the tuner and the app on the same screen, this allows user to check the tuner without having to turn their head or take their attention off the sheet music.
- By having the sheet music uploaded onto the app, the app is able to use the note on the sheet music as a reference, allowing it to only look for that specific pitch. This greatly improves accuracy and allows the inclusion of features like note accuracy or marking notes that were not played in tune.
- The tuner app can have a mode where the tuner is not displayed, and incorrect notes are only shown once the practice is complete for review. Another way to solve this could be that when your note is out of tune, the app plays a drone of the note you are supposed to hit to help users to learn to use their ear to adjust to the correct pitch.

Additional Features:
- Along with acting as a tuner, the main feature of uploading music and opening it in the app allows the incorporation of many additional features. A basic markup tool with pens and highlighters could be used to write notes on the sheet music. Another feature could be clicking on a note and assigning a fingering, which will show up on the piece. There could also be a “Practice Review” where after playing through a piece it identifies parts of the piece you need to work on. There could be a “Spot Practice” feature, where you select a number of bars and you play through it repeatedly while the app tracks your accuracy.  Finally, a “Practice Streak” could be implemented to encourage players to practice consistently.

Current Goal:
- Upload a sheet music
- Have the user play
- Tell them in real time if they are on tune

## Current status

- **Phase 0 (pitch detection foundation): done and validated.** `npm run phase0:validate` passes — was found actually failing at the start of the 2026-08-28 session (a broadband-noise false-triggering bug in the onset detector) despite this status having said "done," and has been fixed; see `CLAUDE.md` for the root cause.
- **Phase 1 core loop: wired end-to-end, substantially debugged, still not fully validated as reliable.** Photo import (via a Python OMR microservice, see `server/`) and MusicXML import both normalize into `ScoreDocument`, render through OpenSheetMusicDisplay, and drive a score-following cursor with a live in-tune/out-of-tune indicator and a post-session practice review summary — all connected in `src/App.tsx`. Score-following has been through several live-testing/redesign rounds; concrete bugs found and fixed along the way include background-noise readings no longer registering as confident notes, MusicXML uploads (not just photo imports) now beaming correctly, tied and same-pitch-slurred notes correctly treated as one continuous note instead of stalling the cursor, and a practice session now actually ending (instead of the cursor visually drifting to the final barline) when a piece completes. A more ambitious continuous-alignment redesign was implemented, live-tested, and reverted after it proved less reliable than the simpler approach it replaced. Still needs further live validation — see `CLAUDE.md`'s score-following section for the full account and known tradeoffs.
- **As of 2026-08-28, metronome-mode tracking (`practice/metronomeFollower.ts`) — not the listening/pitch-driven mode (`practice/cursor.ts`) described above — is the mode the mobile-transition gate is judged against.** Listening mode wasn't landing reliably enough after substantial live-testing; metronome mode showed more promise. Listening mode's code and UI toggle stay in the app, just deprioritized.
- Metronome-mode tracking and the OMR lightweight correction screen are both now built and live-verified on web (see `CLAUDE.md`). Not started: the mobile transition itself (React Native + Expo is the long-term target platform; this repo is currently a web prototype) — gated on metronome mode passing a real live end-to-end play test, which hasn't happened yet.
- See [sheet-music-tuner-plan.md](sheet-music-tuner-plan.md) §11 for the up-to-date status writeup and the mobile transition plan, and `CLAUDE.md` for implementation-level detail on the score-following architecture.

## Project layout

- `audio/` DSP pipeline (preprocessing, pitch detection, onset detection) + web capture module, with unwired native iOS/Android capture stubs for the eventual mobile port
- `score/` shared score schema, MusicXML + OMR import (normalizing to one schema), OSMD-based renderer, and a note-correction UI (pick a misread note, override pitch/duration — see `CLAUDE.md`)
- `practice/` both tracking modes are implemented and wired in — score-following cursor (`cursor.ts`, listening/pitch-driven) and metronome-driven tracking (`metronome.ts` + `metronomeFollower.ts`) — plus post-session review summary (`reviewSummary.ts`); spot-practice and streak tracking are still stub interfaces
- `storage/` DB adapter contract for future `expo-sqlite` integration
- `server/` standalone Python FastAPI microservice that runs OMR (`homr`) on uploaded sheet-music photos; not part of the Node toolchain, must be run separately alongside the web app

## Install

1. Install Node.js 20+.
2. Install dependencies:

```bash
npm install
```

3. The photo-import feature also needs the OMR microservice running (`server/`, Python/FastAPI, requires `uv`/`uvx` on PATH):

```bash
cd server
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Run

```bash
npm run dev:web        # Vite dev server at https://localhost:5173 (self-signed cert; HTTPS is required for mic capture)
```

Both the Vite dev server and the `server/` Python process need to be running at once for sheet-music-photo import to work end-to-end.

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

1. Debug and validate the Phase 1 core loop (HOMR import + metronome-driven score-following + intonation feedback) end-to-end by actually playing violin against a real imported piece — wired and live-tested but not yet confirmed reliable beyond the current baseline piece; see `CLAUDE.md`'s metronome-driven tracking section for what's left to check.
2. Once that gate passes, begin the mobile transition (React Native + Expo) per §11 of the plan — porting the DSP/score/practice logic largely as-is, wiring the native iOS/Android capture stubs in `audio/captureModule`, and rebuilding the renderer as an OSMD-in-WebView bridge.
3. Phase 2/3 features (ear training mode, fingering annotation, markup, spot practice, streak) are planned to be built natively in the mobile app after the transition, not prototyped further on web.
