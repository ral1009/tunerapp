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

- **Phase 0 (pitch detection foundation): done and validated.** `npm run phase0:validate` passes.
- **Phase 1 core loop: wired end-to-end, but not yet working well.** Photo import (via a Python OMR microservice, see `server/`) and MusicXML import both normalize into `ScoreDocument`, render through OpenSheetMusicDisplay, and drive an onset-detection score-following cursor with a live in-tune/out-of-tune indicator and a post-session practice review summary — all connected in `src/App.tsx`. This is early-stage and still needs real debugging against actual playing, not a finished loop yet.
- Not started: metronome, the OMR lightweight correction screen, and the mobile transition (React Native + Expo is the long-term target platform; this repo is currently a web prototype).
- See [sheet-music-tuner-plan.md](sheet-music-tuner-plan.md) §11 for the up-to-date status writeup and the mobile transition plan.

## Project layout

- `audio/` DSP pipeline (preprocessing, pitch detection, onset detection) + web capture module, with unwired native iOS/Android capture stubs for the eventual mobile port
- `score/` shared score schema, MusicXML + OMR import (normalizing to one schema), OSMD-based renderer, and a correction-UI data layer (no UI built yet)
- `practice/` score-following cursor (`cursor.ts`) and post-session review summary (`reviewSummary.ts`) are implemented and wired in; metronome, spot-practice, and streak tracking are still stub interfaces
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

1. Debug and validate the Phase 1 core loop (HOMR import + live tuner + score-following + intonation feedback) end-to-end by actually playing violin against a real imported piece — it's wired but not working reliably yet.
2. Once that gate passes, close out the rest of Phase 1: metronome, OMR lightweight correction screen.
3. Begin the mobile transition (React Native + Expo) per §11 of the plan — porting the DSP/score/practice logic largely as-is, wiring the native iOS/Android capture stubs in `audio/captureModule`, and rebuilding the renderer as an OSMD-in-WebView bridge.
4. Phase 2/3 features (ear training mode, fingering annotation, markup, spot practice, streak) are planned to be built natively in the mobile app after the transition, not prototyped further on web.
