import { useCallback, useEffect, useRef, useState } from 'react';

import type { NoteAccuracyRecord } from '@core/practice/cursor';
import {
  analysisFrameSizeFor,
  OFFLINE_ANALYSIS_INTERVAL_SECONDS,
  OFFLINE_SMOOTHING_FRAMES,
  scoreRecordingOffline,
  type AlignmentPoint,
} from '@core/practice/offlineIntonationScorer';
import { gradingOptions, type GradeReference, type GradeStrictness } from '@core/practice/reviewSummary';
import { passIsOver, resolveSpotRegion, summarizePass, type SpotPassResult, type SpotRegion } from '@core/practice/spotPractice';
import type { CursorNoteInfo, QuarterIndexEntry } from '@core/score/renderer/scoreCursor';

import { LiveTuner } from '@/audio/liveTuner';
import { useMic } from '@/audio/useMic';
import type { MicStatus } from '@/audio/micTypes';

import { AlignmentSession, type SessionStatus } from './alignmentSession';

// Matches DEFAULT_MATCHMAKER_FOLLOWER_CONFIG and the web app's post-take scoring config, so a take
// on the phone is graded exactly like one in the browser.
const SCORING_CONFIG = {
  inTuneCentsThreshold: 15,
  minSamplesForVerdict: 2,
  settleMs: 40,
  plausibilityHighConfidenceThreshold: 0.8,
  plausibilityLowConfidenceCentsLimit: 250,
  plausibilityAbsoluteCentsLimit: 1000,
};
// OLTW wobbles a frame or two around a transition: move only once two updates agree.
const POSITION_STABILITY_COUNT = 2;
// After a jump, positions the server computed before hearing about it are ignored this long.
const JUMP_SETTLE_MS = 400;
// The server's post-take reply normally takes well under a second; this only guards a failure.
const OFFLINE_TIMEOUT_MS = 15000;
const SPOT_PASS_END_PAUSE_MS = 1200;
const SPOT_NEXT_PASS_DELAY_MS = 1500;

export type PracticePhase = 'loading' | 'connecting' | 'preparing' | 'ready' | 'playing' | 'scoring' | 'between' | 'done' | 'error';

export interface PracticeResult {
  records: NoteAccuracyRecord[];
  source: 'offline' | 'live';
  region: { fromBar: number; toBar: number } | null;
}

export interface PracticeOptions {
  xml: string;
  notes: CursorNoteInfo[] | null; // from the score engine once it has drawn the score
  quarterIndex: QuarterIndexEntry[];
  region: { fromBar: number; toBar: number } | null;
  reference: GradeReference;
  strictness: GradeStrictness;
  moveCursor: (quarter: number) => void;
  onTake: (result: PracticeResult) => void; // each graded take (each pass, when looping)
}

function stepIndexAt(index: QuarterIndexEntry[], quarter: number): number | null {
  let found: number | null = null;
  for (const entry of index) {
    if (entry.quarter <= quarter + 1e-9) found = entry.stepIndex;
    else break;
  }
  return found;
}

export function usePractice(options: PracticeOptions) {
  const { notes, region } = options;
  const [phase, setPhase] = useState<PracticePhase>('loading');
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('connecting');
  const [currentStep, setCurrentStep] = useState<number | null>(null);
  const [liveHz, setLiveHz] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [passes, setPasses] = useState<SpotPassResult[]>([]);
  const [spotRegion, setSpotRegion] = useState<SpotRegion | null>(null);

  const sessionRef = useRef<AlignmentSession | null>(null);
  const connectingRef = useRef(false);
  const tunerRef = useRef<LiveTuner | null>(null);
  const optionsRef = useRef(options);
  const pendingRef = useRef<{ step: number | null; count: number }>({ step: null, count: 0 });
  const ignoreUntilRef = useRef(0);
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopingRef = useRef(region !== null);
  const passCountRef = useRef(0);
  const beginTakeRef = useRef<() => void>(() => undefined);
  const noiseFloorRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    optionsRef.current = options;
  });

  const resolvedRegion = useCallback((): SpotRegion | null => {
    const o = optionsRef.current;
    if (!o.region || !o.notes) return null;
    const r = resolveSpotRegion(o.notes, o.quarterIndex, o.region.fromBar, o.region.toBar);
    return typeof r === 'string' ? null : r;
  }, []);

  // ---- scoring -----------------------------------------------------------------------------------
  const scoreTake = useCallback(async (session: AlignmentSession, path: AlignmentPoint[] | null) => {
    const o = optionsRef.current;
    if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
    offlineTimerRef.current = null;
    if (!o.notes) return;
    setPhase('scoring');
    if (!path || path.length < 2) {
      setError('The alignment server didn’t send the take back, so it couldn’t be graded.');
      setPhase('error');
      return;
    }
    const sampleRate = session.rate;
    const { silenceRmsThreshold, gainScalar } = session.levels();
    const records = await scoreRecordingOffline(
      session.recordedAudio(),
      path,
      o.notes,
      o.quarterIndex,
      {
        sampleRate,
        gainScalar,
        silenceRmsThreshold,
        frameSize: analysisFrameSizeFor(sampleRate, 2048),
        hopSize: Math.round(sampleRate * OFFLINE_ANALYSIS_INTERVAL_SECONDS),
        confidenceThreshold: 0.67,
        lowCutHz: 80,
        highCutHz: 3500,
        smoothingWindowFrames: OFFLINE_SMOOTHING_FRAMES,
      },
      SCORING_CONFIG,
      (f) => setProgress(f),
    );
    o.onTake({ records, source: 'offline', region: o.region });
    const spot = resolvedRegion();
    if (spot) {
      passCountRef.current += 1;
      const pass = summarizePass(passCountRef.current, records, spot, gradingOptions(o.reference, o.strictness));
      if (pass.notPlayed < pass.notes) setPasses((prev) => [...prev, pass]);
      if (loopingRef.current) {
        setPhase('between');
        setTimeout(() => {
          if (loopingRef.current) beginTakeRef.current();
        }, SPOT_NEXT_PASS_DELAY_MS);
        return;
      }
    }
    setPhase('done');
  }, [resolvedRegion]);

  // ---- a take ------------------------------------------------------------------------------------
  const beginTake = useCallback(async () => {
    const previous = sessionRef.current;
    if (previous?.noiseFloorRms !== undefined) noiseFloorRef.current = previous.noiseFloorRms;
    previous?.stop();
    const session = new AlignmentSession({
      onStatus: (status) => {
        setSessionStatus(status);
        if (status === 'streaming') setPhase('playing');
      },
      onPosition: (quarter) => {
        if (Date.now() < ignoreUntilRef.current) return;
        const o = optionsRef.current;
        const step = stepIndexAt(o.quarterIndex, quarter);
        const pending = pendingRef.current;
        if (step === pending.step) pending.count += 1;
        else pendingRef.current = { step, count: 1 };
        if (pendingRef.current.count === POSITION_STABILITY_COUNT) {
          o.moveCursor(quarter);
          setCurrentStep(step);
        }
      },
      onOfflinePath: (path) => void scoreTake(session, path),
      onClosed: () => undefined,
      onError: (message) => {
        setError(message);
        setPhase('error');
      },
    }, noiseFloorRef.current);
    sessionRef.current = session;
    connectingRef.current = false;
    pendingRef.current = { step: null, count: 0 };
    setCurrentStep(null);
    setError(null);
    setProgress(0);
    setPhase('connecting');
  }, [scoreTake]);

  useEffect(() => {
    beginTakeRef.current = () => void beginTake();
  }, [beginTake]);

  const onChunk = useCallback((chunk: { samples: Float32Array; sampleRate: number }) => {
    tunerRef.current?.push(chunk.samples, chunk.sampleRate);
    const session = sessionRef.current;
    if (!session) return;
    if (!connectingRef.current) {
      connectingRef.current = true;
      const o = optionsRef.current;
      session
        .connect(o.xml, chunk.sampleRate)
        .then(() => {
          const spot = resolvedRegion();
          setSpotRegion(spot);
          // A loop starts at its first note: the same seek "Jump to bar" sends, before any audio.
          const start = spot ? spot.fromQuarter : optionsRef.current.quarterIndex[0]?.quarter ?? 0;
          if (spot) session.seek(spot.fromQuarter);
          optionsRef.current.moveCursor(start);
          setCurrentStep(spot ? spot.firstStepIndex : optionsRef.current.quarterIndex[0]?.stepIndex ?? null);
          ignoreUntilRef.current = Date.now() + JUMP_SETTLE_MS;
          setPhase('ready');
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
        });
      return;
    }
    session.push(chunk.samples);
  }, [resolvedRegion]);

  const mic = useMic(onChunk);
  const { start: startMic, stop: stopMic } = mic;

  // Live note for the readout, from the same microphone.
  useEffect(() => {
    tunerRef.current = new LiveTuner((reading) => setLiveHz(reading.frequencyHz), 2048);
    return () => {
      tunerRef.current = null;
    };
  }, []);

  // Start once the score engine has given us the notes.
  const started = useRef(false);
  useEffect(() => {
    if (!notes || started.current) return;
    started.current = true;
    void beginTake();
    void startMic();
  }, [notes, beginTake, startMic]);

  useEffect(
    () => () => {
      loopingRef.current = false;
      sessionRef.current?.stop();
      stopMic();
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current);
    },
    [stopMic],
  );

  // ---- controls ----------------------------------------------------------------------------------
  const finish = useCallback((stopLooping: boolean) => {
    if (stopLooping) loopingRef.current = false;
    const session = sessionRef.current;
    if (!session) return;
    if (session.chunksSent === 0) {
      // Nothing played: nothing to grade.
      session.stop();
      setPhase('done');
      return;
    }
    session.finish();
    setPhase('scoring');
    offlineTimerRef.current = setTimeout(() => void scoreTake(session, null), OFFLINE_TIMEOUT_MS);
  }, [scoreTake]);

  const jumpToBar = useCallback((bar: number): string | null => {
    const o = optionsRef.current;
    if (!o.notes) return null;
    const entry = [...o.quarterIndex].sort((a, b) => a.quarter - b.quarter).find((e) => (o.notes?.[e.stepIndex]?.measureIndex ?? -1) + 1 >= bar);
    if (!entry) return `There's no bar ${bar} with notes in this score.`;
    if (!sessionRef.current?.seek(entry.quarter)) return 'Not connected to the alignment server.';
    ignoreUntilRef.current = Date.now() + JUMP_SETTLE_MS;
    pendingRef.current = { step: null, count: 0 };
    o.moveCursor(entry.quarter);
    setCurrentStep(entry.stepIndex);
    return null;
  }, []);

  // Spot practice: a pass ends past the loop, or on its last note with the player stopped.
  const paused = sessionStatus === 'paused';
  useEffect(() => {
    if (!spotRegion || phase !== 'playing' && phase !== 'ready') return;
    if (currentStep === null) return;
    if (passIsOver(currentStep, spotRegion, false)) {
      finish(false);
      return;
    }
    if (!passIsOver(currentStep, spotRegion, paused)) return;
    const timer = setTimeout(() => finish(false), SPOT_PASS_END_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [spotRegion, phase, currentStep, paused, finish]);

  return {
    phase,
    sessionStatus,
    micStatus: mic.status as MicStatus,
    micError: mic.error,
    currentStep,
    liveHz,
    error,
    progress,
    passes,
    spotRegion,
    looping: region !== null,
    finish,
    jumpToBar,
    retry: () => {
      started.current = false;
      void beginTake();
    },
  };
}
