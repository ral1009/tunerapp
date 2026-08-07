# Sheet Music Tuner

Violin-first sheet music practice app built in phases from [sheet-music-tuner-plan.md](sheet-music-tuner-plan.md).

## Project Overview
Potential Idea:
Sheet Music Tuner App
Problems to address:
Having both a tuner app and sheet music on a stand is inconvenient to the user, they must rapidly switch tabs or look at two places at once, making using a tuner while practicing very inconvenient 
Current violin tuner apps are not very accurate with fast notes and sometimes imagine very high or low notes due to background noise
Tuner apps cause users to develop bad habits and doesn’t help them train their ear, they become overreliant on the app and are unable to play without it. Trains their eyes to look at a screen instead of using their ears
Overview of App:
An app where users can upload their sheet music and the notes are identified by the app. The app allows the user to play through the song by looking at the sheet music opened on the app, while the app listens to your playing and tracks your intonation. 
Solutions:
By having both the tuner and the app on the same screen, this allows user to check the tuner without having to turn their head or take their attention off the sheet music.
By having the sheet music uploaded onto the app, the app is able to use the note on the sheet music as a reference, allowing it to only look for that specific pitch. This greatly improves accuracy and allows the inclusion of features like note accuracy or marking notes that were not played in tune.
The tuner app can have a mode where the tuner is not displayed, and incorrect notes are only shown once the practice is complete for review. Another way to solve this could be that when your note is out of tune, the app plays a drone of the note you are supposed to hit to help users to learn to use their ear to adjust to the correct pitch.
Additional Features:
Along with acting as a tuner, the main feature of uploading music and opening it in the app allows the incorporation of many additional features. A basic markup tool with pens and highlighters could be used to write notes on the sheet music. Another feature could be clicking on a note and assigning a fingering, which will show up on the piece. There could also be a “Practice Review” where after playing through a piece it identifies parts of the piece you need to work on. There could be a “Spot Practice” feature, where you select a number of bars and you play through it repeatedly while the app tracks your accuracy.  Finally, a “Practice Streak” could be implemented to encourage players to practice consistently.
Current Goal:
Upload a sheet music
Have the user play
Tell them in real time if they are on tune

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
