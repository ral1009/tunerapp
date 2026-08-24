// Standalone scripted harness for ScoreFollower's bidirectional resync logic. There's no Jest/
// Vitest in this repo -- run via `npm run followerTest` (tsx, same pattern as
// audio/__tests__/offline-validation/runValidation.ts). Exercises ScoreFollower against a mock
// ScoreCursor (plain array, no OSMD/DOM dependency) with hand-built synthetic frame sequences, so
// resync/reattack/deadline outcomes are deterministic and don't require live mic input.
import { ScoreFollower, INSERTION_EDIT_DISTANCE, type ScoreFollowerConfig } from "../cursor";
import type { CursorNoteInfo, ScoreCursor } from "../../score/renderer/scoreCursor";
import type { LivePitchFrame } from "../../audio/captureModule";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

// 4 semitones apart -- comfortably beyond the default pitchMatchToleranceSemitones (3), so
// distinct scale notes never accidentally cross-match each other.
function noteFreq(semitoneOffset: number): number {
  return 440 * Math.pow(2, semitoneOffset / 12);
}

const SCALE = Array.from({ length: 10 }, (_, i) => noteFreq(i * 4));

// durationQuarterNotes defaults to 1 (a plain quarter note) -- only scenarios exercising tempo
// estimation (recordTempoSample/computeAdaptiveMinStableMs) need to pass a different value.
function makeNote(stepIndex: number, freqHz: number, durationQuarterNotes = 1): CursorNoteInfo {
  return {
    stepIndex,
    measureIndex: Math.floor(stepIndex / 4),
    frequenciesHz: [freqHz],
    primaryFrequencyHz: freqHz,
    pitchLabel: `N${stepIndex}`,
    isRest: false,
    durationQuarterNotes
  };
}

// Plain in-memory array standing in for OSMD's Cursor -- pure index arithmetic, implementing the
// full ScoreCursor contract (including the resync primitives) the same way
// score/renderer/scoreCursor.ts does against the real OSMD iterator.
// durationsQuarterNotes is an optional parallel array (falls back to 1 per note when omitted or
// shorter than frequencies) -- only needed by tempo-estimation scenarios.
function createMockScoreCursor(frequencies: number[], durationsQuarterNotes?: number[]): ScoreCursor {
  const notes = frequencies.map((freq, i) => makeNote(i, freq, durationsQuarterNotes?.[i] ?? 1));
  let index = -1;

  return {
    reset(): CursorNoteInfo | null {
      index = 0;
      return notes.length > 0 ? notes[0] : null;
    },
    isAtEnd(): boolean {
      return index >= notes.length - 1;
    },
    current(): CursorNoteInfo | null {
      return index >= 0 && index < notes.length ? notes[index] : null;
    },
    advanceToNextNote(): CursorNoteInfo | null {
      if (index >= notes.length - 1) {
        index = notes.length;
        return null;
      }
      index += 1;
      return notes[index];
    },
    peekNextNote(): CursorNoteInfo | null {
      const next = index + 1;
      return next < notes.length ? notes[next] : null;
    },
    retreatToPreviousNote(): CursorNoteInfo | null {
      if (index <= 0) {
        return null;
      }
      index -= 1;
      return notes[index];
    },
    advanceBy(n: number): CursorNoteInfo | null {
      let lastValid = index >= 0 && index < notes.length ? notes[index] : null;
      for (let i = 0; i < n; i += 1) {
        if (index >= notes.length - 1) {
          break;
        }
        index += 1;
        lastValid = notes[index];
      }
      return lastValid;
    },
    retreatBy(n: number): CursorNoteInfo | null {
      let lastValid = index >= 0 && index < notes.length ? notes[index] : null;
      for (let i = 0; i < n; i += 1) {
        if (index <= 0) {
          break;
        }
        index -= 1;
        lastValid = notes[index];
      }
      return lastValid;
    },
    peekWindow(aheadCount: number, behindCount: number): Array<{ offset: number; note: CursorNoteInfo }> {
      const results: Array<{ offset: number; note: CursorNoteInfo }> = [];
      for (let offset = 1; offset <= aheadCount; offset += 1) {
        const i = index + offset;
        if (i < notes.length) {
          results.push({ offset, note: notes[i] });
        }
      }
      for (let offset = 1; offset <= behindCount; offset += 1) {
        const i = index - offset;
        if (i >= 0) {
          results.push({ offset: -offset, note: notes[i] });
        }
      }
      return results;
    },
    show(): void {},
    hide(): void {},
    setHighlightColor(): void {},
    highlightNotes(): void {}
  };
}

interface SimFrame {
  freq: number | null;
  onset?: boolean;
  silent?: boolean;
  reason?: LivePitchFrame["reason"];
  onsetConfidence?: LivePitchFrame["onsetConfidence"];
}

function feed(
  follower: ScoreFollower,
  frames: SimFrame[],
  clock: { t: number },
  stepMs = 10
): ReturnType<ScoreFollower["getState"]> {
  let state = follower.getState();
  for (const f of frames) {
    clock.t += stepMs;
    const frame: LivePitchFrame = {
      samples: new Float32Array(0),
      timestampMs: clock.t,
      sampleRate: 44100,
      frequencyHz: f.freq,
      note: null,
      centsOff: null,
      confidence: f.freq !== null ? 1 : 0,
      rms: f.silent ? 0 : 0.1,
      isSilent: f.silent ?? false,
      onsetDetected: f.onset ?? false,
      reason: f.reason ?? null,
      onsetConfidence: f.onsetConfidence ?? null
    };
    state = follower.onLiveFrame(frame);
  }
  return state;
}

// One onset's worth of frames that reach attackSettleMs (default 40ms, 10ms/frame) so the
// resolution logic actually gets to the settle-gated checks (fast path is checked every frame
// regardless, so if `freq` matches something on frame 1 it'll resolve immediately anyway).
function onsetFrames(freq: number | null): SimFrame[] {
  return [
    { freq, onset: true },
    { freq },
    { freq },
    { freq },
    { freq }
  ];
}

// Frames simulating a legato/slurred transition to `freq` with NO onset ever detected --
// exercises ImplicitOnsetWatcher instead of frame.onsetDetected. count*stepMs must exceed
// implicitOnsetMinStableMs (default 200ms @ 10ms/frame => needs >=21 frames); 25 gives headroom.
function legatoDriftFrames(freq: number, count = 25): SimFrame[] {
  return Array.from({ length: count }, () => ({ freq, onset: false }));
}

// Sinusoidal vibrato around centerFreq, depthSemitones deep, cycleMs long, held for totalMs --
// for the vibrato false-positive/false-negative guard scenarios below. No onset frames.
function vibratoFrames(centerFreq: number, depthSemitones: number, cycleMs: number, totalMs: number): SimFrame[] {
  const frames: SimFrame[] = [];
  for (let t = 10; t <= totalMs; t += 10) {
    const offset = depthSemitones * Math.sin((2 * Math.PI * t) / cycleMs);
    frames.push({ freq: centerFreq * Math.pow(2, offset / 12), onset: false });
  }
  return frames;
}

function scenario(name: string, run: () => void): void {
  console.log(`\n${name}`);
  const before = failed;
  run();
  if (failed === before) {
    console.log("  ok");
  }
}

// 1. Plain forward progression, no resync -- regression guard on the untouched fast path.
scenario("1. plain forward progression", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  const state = feed(
    follower,
    [
      { freq: SCALE[0], onset: true },
      { freq: SCALE[0] },
      { freq: SCALE[1], onset: true },
      { freq: SCALE[1] },
      { freq: SCALE[2], onset: true },
      { freq: SCALE[2] }
    ],
    clock
  );

  assertEqual(state.current?.stepIndex ?? null, 2, "cursor lands on stepIndex 2");
  assertEqual(state.history.length, 2, "two notes finalized into history");
  const trace = follower.getTrace();
  assertEqual(trace.length, 2, "two traced advance decisions");
  assert(
    trace.every((e) => e.reason === "next_note_immediate"),
    "both decisions were the fast path"
  );
});

// 2. Single missed note (skip forward 2). Since SCALE pitches are globally unique, a single
// onset's pitch already uniquely identifies the target -- resolves on the FIRST onset, no need to
// wait for a second note. Also verifies the player's very next (correct) onset afterward resolves
// via the ordinary fast path immediately -- i.e. the resync landed exactly in sync, not behind.
scenario("2. missed note, skip forward 2 -- resolves on first onset, no lag afterward", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 6));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  // Player skips note 1 entirely and plays note 2's pitch -- unique in this window, so this
  // single onset is enough.
  const state = feed(follower, onsetFrames(SCALE[2]), clock);

  assertEqual(state.current?.stepIndex ?? null, 2, "cursor resyncs forward to stepIndex 2 on the first onset");
  assertEqual(state.history.length, 2, "outgoing note + skipped-note stub both in history");
  assertEqual(state.history[0]?.stepIndex, 0, "history[0] is the outgoing note (stepIndex 0)");
  assertEqual(state.history[1]?.stepIndex, 1, "history[1] is the skipped-note stub (stepIndex 1)");
  assertEqual(state.history[1]?.verdict, "not_played", "skipped note recorded as not_played");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "sequence_confirmed", "resolved via a confirmed sequence match");
  assertEqual(last?.offset, 2, "resync offset was +2");

  // The player's next note (correctly, note 3) should now resolve via the plain fast path --
  // proof the resync landed the cursor in sync rather than leaving it trailing behind.
  const nextState = feed(follower, [{ freq: SCALE[3], onset: true }], clock);
  assertEqual(nextState.current?.stepIndex ?? null, 3, "next correct note advances normally");
  assertEqual(follower.getTrace().at(-1)?.reason, "next_note_immediate", "no further resync needed -- back in sync");
});

// 3. Extra bow-stroke re-attack on the same note -> reattack_settled, cents tracking resumes.
scenario("3. re-attack on the same held note", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(
    follower,
    [
      { freq: SCALE[0], onset: true },
      { freq: SCALE[0] },
      { freq: SCALE[1], onset: true },
      { freq: SCALE[1] }
    ],
    clock
  );

  // Re-attack on the still-current note (stepIndex 1): settles after attackSettleMs(40ms).
  const state = feed(follower, onsetFrames(SCALE[1]), clock);

  assertEqual(state.current?.stepIndex ?? null, 1, "cursor stays on the re-attacked note");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "reattack_settled", "resolved as a settled re-attack");
  assertEqual(last?.offset, 0, "re-attack offset is 0");

  // Cents tracking should resume immediately after the reattack resolves.
  const resumed = feed(follower, [{ freq: SCALE[1] }], clock);
  assert(resumed.liveCentsOffFromExpected !== null, "cents tracking resumed right after reattack settled");
});

// 4. Extra/duplicate note requiring step-back -> resolves on the first onset (unique match in
// this window), negative offset, and a duplicate stepIndex shows up in history when the player
// re-advances past it again (backward-correction of already-emitted history is explicitly out of
// scope this round).
scenario("4. extra note requiring step-back", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(
    follower,
    [
      { freq: SCALE[0], onset: true },
      { freq: SCALE[0] },
      { freq: SCALE[1], onset: true },
      { freq: SCALE[1] },
      { freq: SCALE[2], onset: true },
      { freq: SCALE[2] }
    ],
    clock
  );

  // Accidental extra bow stroke replays note 1 (already passed) -- unique, resolves immediately.
  const backState = feed(follower, onsetFrames(SCALE[1]), clock);

  assertEqual(backState.current?.stepIndex ?? null, 1, "cursor steps back to stepIndex 1");
  const backTrace = follower.getTrace().at(-1);
  assertEqual(backTrace?.reason, "sequence_confirmed", "step-back resolved as a confirmed sequence match");
  assertEqual(backTrace?.offset, -1, "resync offset was -1");

  // Re-advance past note 1 a second time.
  const forwardAgain = feed(follower, [{ freq: SCALE[2], onset: true }], clock);
  assertEqual(forwardAgain.current?.stepIndex ?? null, 2, "cursor advances forward again to stepIndex 2");

  const stepIndex1Records = forwardAgain.history.filter((r) => r.stepIndex === 1);
  assertEqual(stepIndex1Records.length, 2, "stepIndex 1 appears twice in history (accepted, not corrected)");
});

// 5. The exact postmortem repro: first frames after onset read close to the departing note
// before a later frame reads the true next note, within one pendingTransitionWindowMs. Must
// still advance -- direct regression test for the reverted bug (offset-0 used to resolve
// unconditionally and immediately, consuming the onset before the retry window got a chance to
// see the later, correct frame).
scenario("5. postmortem repro -- messy attack transient before a correct reading", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  const state = feed(
    follower,
    [
      { freq: SCALE[0], onset: true }, // onset toward note 1, but reads the departing note (0)
      { freq: SCALE[0] }, // still messy, elapsed 10ms -- settle gate (40ms) not open yet
      { freq: SCALE[1] } // settles onto the true next note -- fast path commits immediately
    ],
    clock
  );

  assertEqual(state.current?.stepIndex ?? null, 1, "cursor still advances despite the messy transient frames");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "next_note_immediate", "advance resolved via the fast path once the reading settled");
});

// 6. Ambiguous single-note match -- a repeated 2-note pattern appears both behind and ahead of
// the stale cursor position. A single played note can't disambiguate them (this is exactly the
// "play E E" case reported live: committing off one note lands on a stale, already-passed
// position while the player has moved on). The follower must WAIT for a second onset rather than
// guess, then resolve via the documented forward tie-break once the 2-note buffer hits
// resyncMaxSequenceLength, landing on the LAST note of the matched sequence (ready for the
// player's actual next note, not behind it).
scenario("6. ambiguous single-note match waits for a second note, then resolves via sequence", () => {
  // notes: [filler(-3), P1(-2), P2(-1), current(0), near1(+1), P1(+2), P2(+3)]
  const filler = noteFreq(8);
  const p1 = noteFreq(40);
  const p2 = noteFreq(44);
  const current = noteFreq(0);
  const near1 = noteFreq(4);
  const cursor = createMockScoreCursor([filler, p1, p2, current, near1, p1, p2]);
  const config: Partial<ScoreFollowerConfig> = {
    resyncMaxSequenceLength: 2,
    resyncWindowAhead: 5,
    resyncWindowBehind: 5
  };
  const follower = new ScoreFollower(cursor, config);
  follower.start();
  const clock = { t: 0 };

  // Walk forward to stepIndex 3 ("current" in the layout above) via ordinary fast-path advances.
  feed(
    follower,
    [
      { freq: filler, onset: true },
      { freq: filler },
      { freq: p1, onset: true },
      { freq: p1 },
      { freq: p2, onset: true },
      { freq: p2 },
      { freq: current, onset: true },
      { freq: current }
    ],
    clock
  );
  assertEqual(follower.getState().current?.stepIndex ?? null, 3, "setup: positioned at stepIndex 3");

  // First played note (P1) matches both offset -2 and offset +2 -- ambiguous, must wait.
  const afterFirst = feed(follower, onsetFrames(p1), clock);
  assertEqual(afterFirst.current?.stepIndex ?? null, 3, "cursor does not move on an ambiguous single note");
  assertEqual(follower.getTrace().at(-1)?.reason, "sequence_ambiguous", "first note alone is ambiguous, waits");

  // Second played note (P2) extends the sequence to [P1, P2], still matching both -2 and +2 --
  // buffer has now reached resyncMaxSequenceLength(2), forcing a decision via the forward
  // tie-break (equal |offset|).
  const afterSecond = feed(follower, onsetFrames(p2), clock);
  assertEqual(afterSecond.current?.stepIndex ?? null, 6, "resolves forward, landing on the LAST matched note (P2 at +3)");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "sequence_confirmed", "resolved once the buffer forced a tie-break decision");
  assertEqual(last?.offset, 3, "committed offset is +3 (forward tie-break), not -3");
});

// 7. No usable pitch reading at all (frequencyHz stays null) -> deadline_expired, cursor stays
// stranded (existing behavior, preserved).
scenario("7. no usable pitch reading -> deadline_expired", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  const frames: SimFrame[] = [{ freq: null, onset: true }];
  for (let i = 0; i < 16; i += 1) {
    frames.push({ freq: null });
  }
  const state = feed(follower, frames, clock); // 16 * 10ms = 160ms > pendingTransitionWindowMs(150)

  assertEqual(state.current?.stepIndex ?? null, 0, "cursor stays stranded on stepIndex 0");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "deadline_expired", "pending transition expired unresolved");
  assertEqual(last?.offset, null, "no offset recorded for an expired deadline");
});

// 8. A settled pitch that matches nothing anywhere in the search window -> discarded as noise
// (not stranded for the full deadline -- resolves as soon as it settles, ~attackSettleMs).
scenario("8. junk pitch matching nothing -> discarded, cursor stays put", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  const junkFreq = noteFreq(97); // well outside the whole scale + resync window
  const state = feed(follower, onsetFrames(junkFreq), clock);

  assertEqual(state.current?.stepIndex ?? null, 0, "cursor stays put");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "sequence_note_discarded", "junk reading discarded rather than committed");
});

// 9. Implicit trigger resolves a legato transition with no onsetDetected frame at all -- direct
// regression guard for the diagnosed root cause (OnsetDetector misses legato/slurred note
// changes, silently breaking both ordinary advancement and sequence resync's contiguous-match
// assumption).
scenario("9. implicit trigger resolves a legato transition with no onset", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  const state = feed(follower, legatoDriftFrames(SCALE[1]), clock);

  assertEqual(state.current?.stepIndex ?? null, 1, "cursor advances via the implicit trigger");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "next_note_immediate", "resolved via the fast path once the drift triggered");
  assertEqual(last?.triggerSource, "implicit", "trigger source recorded as implicit, not onset");
});

// 10. Sustained vibrato on the HELD current note never false-triggers an implicit boundary --
// readings stay near the reference pitch throughout, so they never even enter the drift window.
// Depth (1.4 semitones) is deliberately set close to implicitOnsetStabilityToleranceSemitones's
// default (1.5) -- this is the direct regression test for a live bug: at the previous, tighter
// default (0.6), heavy/expressive violin vibrato was misread as an advance to the next note.
scenario("10. heavy vibrato on the held current note never false-triggers", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  // 10 full cycles -- comfortably longer than implicitOnsetMinStableMs if it were (wrongly)
  // accumulating.
  const state = feed(follower, vibratoFrames(SCALE[0], 1.4, 150, 1500), clock);

  assertEqual(state.current?.stepIndex ?? null, 0, "cursor never leaves stepIndex 0");
  assertEqual(follower.getTrace().length, 0, "no resync decisions were ever made");
});

// 11. Implicit-triggered legato note immediately followed by a real onset -- the proximity/
// interaction case: exactly the kind of thing that has passed clean in isolation before and
// broken live. Must not double-advance or race.
scenario("11. implicit-triggered note immediately followed by a real onset", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  // Implicit trigger advances to stepIndex 1 with no onset...
  const afterImplicit = feed(follower, legatoDriftFrames(SCALE[1]), clock);
  assertEqual(afterImplicit.current?.stepIndex ?? null, 1, "implicit trigger advances to stepIndex 1");

  // ...immediately followed (no gap) by a real onset for the next note.
  const afterOnset = feed(follower, [{ freq: SCALE[2], onset: true }], clock);

  assertEqual(afterOnset.current?.stepIndex ?? null, 2, "real onset advances to stepIndex 2, no double-advance");
  const trace = follower.getTrace();
  const advanceEntries = trace.filter((e) => e.offset === 1);
  assertEqual(advanceEntries.length, 2, "exactly two +1 advances recorded, not three or one");
  assertEqual(trace.at(-1)?.triggerSource, "onset", "the second advance was sourced from the real onset");
  const stepIndex1Records = afterOnset.history.filter((r) => r.stepIndex === 1);
  assertEqual(stepIndex1Records.length, 1, "stepIndex 1 recorded exactly once, not skipped or duplicated");
});

// 12. implicitOnsetEnabled: false regression guard -- proves the kill switch genuinely disables
// the new path (reverting to the old stuck-on-legato behavior) rather than only suppressing its
// effects.
scenario("12. implicitOnsetEnabled: false reverts to old (stuck) behavior", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor, { implicitOnsetEnabled: false });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);
  const state = feed(follower, legatoDriftFrames(SCALE[1]), clock);

  assertEqual(state.current?.stepIndex ?? null, 0, "cursor stays stranded with the kill switch off");
  assertEqual(follower.getTrace().length, 0, "no implicit resync activity at all");
});

// 13. Vibrato applied to the ARRIVAL note, starting immediately as the legato drift begins (not
// after a settle period) -- the gap a second reviewer specifically flagged: a naive full-window
// span-based consistency check breaks here, since vibrato's own spread can exceed a tight
// tolerance before minStableMs elapses, so the run never survives long enough to trigger --
// silently reintroducing the exact missed-note problem this feature exists to fix. Verifies the
// running-centroid design (which adapts to the note being held) resolves this correctly instead.
scenario("13. implicit trigger still resolves when the arrival note has immediate vibrato", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 5));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);

  // Vibrato on SCALE[1] (the arrival note) from the very first drifted frame -- 1.4 semitone
  // depth (matching the "heavy vibrato" ceiling implicitOnsetStabilityToleranceSemitones is now
  // sized against), 150ms cycle, held for 400ms (~2.7 cycles) to give the trigger room to fire
  // once its 200ms threshold is crossed.
  const state = feed(follower, vibratoFrames(SCALE[1], 1.4, 150, 400), clock);

  assertEqual(state.current?.stepIndex ?? null, 1, "cursor still advances despite vibrato on the arrival note");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.triggerSource, "implicit", "resolved via the implicit trigger");
});

// 14. LivePitchFrame.reason flows through to ScoreFollowerState.lastPitchReason as a pure
// diagnostic mirror -- no resync/onset decision reads it, so this only verifies plumbing, not
// behavior. Guards Phase 0 of the resync/onset robustness plan (see the plan doc): confidence
// data was already computed by PitchDetector but silently dropped before reaching the follower.
scenario("14. lastPitchReason mirrors the live frame's reason diagnostically", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 3));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }, { freq: SCALE[0] }], clock);
  const rejected = feed(follower, [{ freq: null, reason: "low_confidence" }], clock);
  assertEqual(rejected.lastPitchReason, "low_confidence", "reason surfaces on a rejected frame");

  const confident = feed(follower, [{ freq: SCALE[0] }], clock);
  assertEqual(confident.lastPitchReason, null, "reason clears back to null on a confident reading");
});

// 15. Direct regression guard for fuzzySequenceMatchingEnabled -- the diagnosed root cause of
// resync resolving rarely: a missed note (the player's onset detection never caught it) leaves a
// gap in the middle of a played sequence, breaking exact-contiguous matching entirely. Layout:
// [current(0), filler(1), R1(2), SKIPPED(3, never played), R2(4), filler(5), R1_dup(6), filler(7),
// filler(8), R2_dup(9)]. R1 and R2 are each individually ambiguous (they also appear, unrelated,
// at offsets 6 and 9), so neither settles the sequence alone -- only recognizing that [R1,R2]
// aligns against the score with ONE score note (the skipped one) missing between them, using BOTH
// readings together, resolves this uniquely and correctly.
scenario("15. fuzzy matching resolves a gapped sequence exact matching can't (kill switch ON)", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const r1 = noteFreq(8);
  const skipped = noteFreq(12);
  const r2 = noteFreq(16);
  const filler2 = noteFreq(20);
  const r1Dup = r1;
  const filler3 = noteFreq(28);
  const filler4 = noteFreq(32);
  const r2Dup = r2;
  const cursor = createMockScoreCursor([current, filler1, r1, skipped, r2, filler2, r1Dup, filler3, filler4, r2Dup]);
  const follower = new ScoreFollower(cursor, {
    resyncWindowAhead: 9,
    resyncWindowBehind: 1,
    fuzzySequenceMatchingEnabled: true
  });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  // R1 alone is ambiguous (matches offset+2 and offset+6) -- waits for more data.
  const afterFirst = feed(follower, onsetFrames(r1), clock);
  assertEqual(afterFirst.current?.stepIndex ?? null, 0, "cursor does not move on R1 alone");
  assertEqual(follower.getTrace().at(-1)?.reason, "sequence_ambiguous", "R1 alone is ambiguous, waits");

  // R2 extends the buffer to [R1,R2]. Exact-contiguous matching finds nothing (R1 is followed by
  // the skipped note, not R2, at its real position); the deletion-tolerant fuzzy match resolves
  // it uniquely and correctly, landing on R2's real position (stepIndex 4) using both readings.
  const afterSecond = feed(follower, onsetFrames(r2), clock);
  assertEqual(afterSecond.current?.stepIndex ?? null, 4, "resolves to R2's real position via the deletion-tolerant match");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "sequence_confirmed", "resolved as a confirmed sequence match");
  assertEqual(last?.offset, 4, "committed offset is +4 (spans the one skipped note)");
  assertEqual(last?.editDistance, 1, "resolved via a deletion-tolerant (editDistance 1) match, not an exact one");
  assertEqual(last?.sequenceLength, 2, "used both readings, not a single-note solo fallback");
});

// 16. Kill-switch-off regression guard -- the exact same gapped layout as scenario 15, but with
// fuzzySequenceMatchingEnabled left at its default (false). Confirms the fix doesn't change
// behavior unless explicitly enabled: exact-contiguous matching still can't bridge the gap, so
// resolution falls back to the old solo-retry-on-R2-alone path, which is itself ambiguous here
// (R2 also appears at its own duplicate, offset+9) -- so it stays unresolved and, critically,
// R1's reading is discarded rather than fixed, exactly the fragility scenario 15 fixes.
scenario("16. kill switch off: identical gapped layout does not resolve (old exact-only behavior)", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const r1 = noteFreq(8);
  const skipped = noteFreq(12);
  const r2 = noteFreq(16);
  const filler2 = noteFreq(20);
  const r1Dup = r1;
  const filler3 = noteFreq(28);
  const filler4 = noteFreq(32);
  const r2Dup = r2;
  const cursor = createMockScoreCursor([current, filler1, r1, skipped, r2, filler2, r1Dup, filler3, filler4, r2Dup]);
  const follower = new ScoreFollower(cursor, { resyncWindowAhead: 9, resyncWindowBehind: 1 });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  feed(follower, onsetFrames(r1), clock);
  const afterSecond = feed(follower, onsetFrames(r2), clock);

  assertEqual(afterSecond.current?.stepIndex ?? null, 0, "cursor stays stranded with the kill switch off");
  assertEqual(follower.getTrace().at(-1)?.reason, "sequence_ambiguous", "still ambiguous -- R2 alone also has a duplicate");
});

// 17. Adversarial/false-positive guard -- verifies fuzzy matching's edit-distance ranking, not
// just proximity, decides ties. Layout: [current(0), filler(1), A_decoy(2), filler(3), A(4),
// B(5), filler(6)]. Neither the immediate next note (filler, stepIndex1) nor current itself
// matches A, so A's onset settles into sequence recording rather than the fast path or the
// offset-0 re-attack, and A is ambiguous alone there (matches the decoy at offset+2 and the real
// occurrence at offset+4). Playing [A,B] has a real EXACT match at offset+4 (A immediately
// followed by B) -- but there's also a spurious insertion-tolerant "match" at offset+2 (treating
// B as noise and using only the decoy A there), which is CLOSER to the current position than the
// true match. If ranking were proximity-only instead of tier-first, this closer-but-wrong
// candidate would win. It must not. Explicitly enables fuzzyInsertionMatchingEnabled (off by
// default -- see its doc comment) since this scenario exists specifically to guard the ranking
// property that makes it safe to enable at all.
scenario("17. fuzzy matching prefers a farther exact match over a closer spurious fuzzy one", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const aDecoy = noteFreq(8);
  const filler2 = noteFreq(12);
  const a = aDecoy;
  const b = noteFreq(16);
  const filler3 = noteFreq(20);
  const cursor = createMockScoreCursor([current, filler1, aDecoy, filler2, a, b, filler3]);
  const follower = new ScoreFollower(cursor, {
    resyncWindowAhead: 6,
    resyncWindowBehind: 1,
    fuzzySequenceMatchingEnabled: true,
    fuzzyInsertionMatchingEnabled: true
  });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  feed(follower, onsetFrames(a), clock);
  assertEqual(follower.getTrace().at(-1)?.reason, "sequence_ambiguous", "A alone is ambiguous (decoy + real)");

  const state = feed(follower, onsetFrames(b), clock);
  assertEqual(state.current?.stepIndex ?? null, 5, "lands on the true exact match (stepIndex 5), not the closer spurious one");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "sequence_confirmed", "resolved as a confirmed sequence match");
  assertEqual(last?.offset, 5, "committed offset is +5, the real exact match, not +2");
});

// 18. Interaction case: a fuzzy-resolved resync commit must leave the follower in a clean state
// for the (independent) implicit-onset trigger to keep working normally right afterward --
// exercising the same commitAdvance -> beginTrackingCurrentNote -> implicitOnsetWatcher.reset()
// path a fuzzy commit now goes through via SequenceMatch.endOffset instead of the old
// startOffset-based formula. Reuses scenario 15's gapped layout, then drifts (no onset) from the
// fuzzy-resolved landing note to the next one.
scenario("18. implicit trigger still works normally right after a fuzzy-resolved resync commit", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const r1 = noteFreq(8);
  const skipped = noteFreq(12);
  const r2 = noteFreq(16);
  const nextNote = noteFreq(20);
  const r1Dup = r1;
  const filler3 = noteFreq(28);
  const filler4 = noteFreq(32);
  const r2Dup = r2;
  const cursor = createMockScoreCursor([current, filler1, r1, skipped, r2, nextNote, r1Dup, filler3, filler4, r2Dup]);
  const follower = new ScoreFollower(cursor, {
    resyncWindowAhead: 9,
    resyncWindowBehind: 1,
    fuzzySequenceMatchingEnabled: true
  });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  feed(follower, onsetFrames(r1), clock);
  const afterFuzzyResync = feed(follower, onsetFrames(r2), clock);
  assertEqual(afterFuzzyResync.current?.stepIndex ?? null, 4, "setup: fuzzy resync landed on stepIndex 4");

  // Legato drift to the next note, no onset at all -- exercises ImplicitOnsetWatcher exactly as
  // scenario 9 does, but immediately following a fuzzy commit instead of an ordinary one.
  const afterImplicit = feed(follower, legatoDriftFrames(nextNote), clock);
  assertEqual(afterImplicit.current?.stepIndex ?? null, 5, "implicit trigger advances normally afterward");
  assertEqual(follower.getTrace().at(-1)?.triggerSource, "implicit", "resolved via the implicit trigger, unaffected by the prior fuzzy commit");
});

// 19. Regression guard for fuzzyInsertionMatchingEnabled defaulting OFF -- modeled directly on a
// live incident (see the plan doc / ScoreFollowerConfig.fuzzyInsertionMatchingEnabled's doc
// comment): an ambiguous reading (P, appearing three times nearby), a spurious junk reading that
// matches nothing anywhere, then P again. Layout: [current(0), filler(1), P_a(2), P_b(3, SAME
// pitch, adjacent to P_a), filler(4), P_dup(5, a third, distant occurrence), filler(6)]. With
// insertion OFF (default), the junk reading is cleanly discarded via the existing
// sequence_note_discarded safety valve without ever entering the persisted buffer, and the
// eventual match is a strictly EXACT one (editDistance 0, using only the 2 real P readings) --
// found because P_a/P_b genuinely are adjacent in the score, not because junk was "explained
// away". With insertion ON, the SAME outcome is instead reached by discarding the junk reading
// as noise inside a 3-long buffer (editDistance 2) -- a real reading's worth of information is
// treated as disposable evidence even though, as this test shows, a strictly safer resolution was
// available without it. That gap between "resolves safely" and "resolves by discarding real
// evidence" is why insertion defaults off even though both configs land on the same offset here --
// in a less fortunate score layout (as in the live incident this models), there'd be no safe
// exact fallback waiting behind it, and insertion would happily commit short anyway.
scenario("19. fuzzyInsertionMatchingEnabled off avoids resolving via discarded evidence", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const pa = noteFreq(8);
  const pb = pa;
  const filler2 = noteFreq(12);
  const pDup = pa;
  const filler3 = noteFreq(16);
  const junk = noteFreq(60);
  const cursor = createMockScoreCursor([current, filler1, pa, pb, filler2, pDup, filler3]);
  const config: Partial<ScoreFollowerConfig> = { resyncWindowAhead: 6, resyncWindowBehind: 1, fuzzySequenceMatchingEnabled: true };

  // Insertion OFF (default) -- the safe path.
  const cursorOff = createMockScoreCursor([current, filler1, pa, pb, filler2, pDup, filler3]);
  const followerOff = new ScoreFollower(cursorOff, config);
  followerOff.start();
  const clockOff = { t: 0 };
  feed(followerOff, [{ freq: current, onset: true }, { freq: current }], clockOff);
  feed(followerOff, onsetFrames(pa), clockOff);
  assertEqual(followerOff.getTrace().at(-1)?.reason, "sequence_ambiguous", "P alone is ambiguous (3 occurrences)");
  feed(followerOff, onsetFrames(junk), clockOff);
  assertEqual(followerOff.getTrace().at(-1)?.reason, "sequence_note_discarded", "junk cleanly discarded, never persisted into the buffer");
  const offState = feed(followerOff, onsetFrames(pa), clockOff);
  assertEqual(offState.current?.stepIndex ?? null, 3, "still resolves correctly (P_a/P_b are genuinely adjacent)");
  const offLast = followerOff.getTrace().at(-1);
  assertEqual(offLast?.reason, "sequence_confirmed", "resolved as a confirmed sequence match");
  assertEqual(offLast?.editDistance, 0, "resolved via a plain exact match, not by discarding the junk reading");
  assertEqual(offLast?.sequenceLength, 2, "junk never inflated the matched sequence length");

  // Insertion ON -- reaches the same offset, but by discarding the junk reading as noise instead.
  const followerOn = new ScoreFollower(cursor, { ...config, fuzzyInsertionMatchingEnabled: true });
  followerOn.start();
  const clockOn = { t: 0 };
  feed(followerOn, [{ freq: current, onset: true }, { freq: current }], clockOn);
  feed(followerOn, onsetFrames(pa), clockOn);
  feed(followerOn, onsetFrames(junk), clockOn);
  assertEqual(
    followerOn.getTrace().at(-1)?.editDistance,
    INSERTION_EDIT_DISTANCE,
    "junk is provisionally 'explained' via insertion tolerance instead of discarded"
  );
  const onState = feed(followerOn, onsetFrames(pa), clockOn);
  assertEqual(onState.current?.stepIndex ?? null, 3, "lands on the same offset as the safe path");
  const onLast = followerOn.getTrace().at(-1);
  assertEqual(
    onLast?.editDistance,
    INSERTION_EDIT_DISTANCE,
    "but resolved by discarding the junk reading as noise, not exactly"
  );
  assertEqual(onLast?.sequenceLength, 3, "the junk reading was carried in the matched sequence, not excluded upfront");
});

// 20. Direct regression guard for adaptiveStabilityWindowEnabled -- at a fast established tempo
// (real onsets 100ms apart), the tempo-scaled window clamps to its floor (150ms: 100ms note *
// 0.75 fraction = 75ms, below the 150ms floor) rather than the static default (200ms). A legato
// drift held for 170ms (comfortably clears the 150ms floor, still well under the static 200ms
// default) must trigger here -- the static default alone never could have, at this tempo, no
// matter how long the piece continued.
scenario("20. adaptive stability window shrinks at fast tempo, clamped to its floor", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 8));
  const follower = new ScoreFollower(cursor, { adaptiveStabilityWindowEnabled: true });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 100);
  feed(follower, [{ freq: SCALE[2], onset: true }], clock, 100);
  feed(follower, [{ freq: SCALE[3], onset: true }], clock, 100);
  assertEqual(follower.getState().current?.stepIndex ?? null, 3, "setup: fast-tempo advances landed at stepIndex 3");

  // 18 frames * 10ms = 180ms span; elapsed from the run's first (stableSinceMs) frame is 170ms.
  const state = feed(follower, legatoDriftFrames(SCALE[4], 18), clock);

  assertEqual(state.current?.stepIndex ?? null, 4, "adaptive window (floor-clamped to 150ms) triggers within 170ms");
  assertEqual(follower.getTrace().at(-1)?.triggerSource, "implicit", "resolved via the implicit trigger");
});

// 21. Adversarial/false-positive guard -- confirms the floor holds even at an extreme tempo (50ms
// established quarter-note pace, well beyond anything scenario 20 exercised), and that heavy
// vibrato (same 1.4-semitone depth as scenario 10) on the CURRENT note still never false-triggers
// there. Vibrato safety comes from stabilityToleranceSemitones, not from the window being long --
// this must keep holding even at the smallest window the adaptive feature can ever produce.
scenario("21. adaptive window respects its floor at extreme tempo, and heavy vibrato still doesn't false-trigger there", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 6));
  const follower = new ScoreFollower(cursor, { adaptiveStabilityWindowEnabled: true });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 50);
  feed(follower, [{ freq: SCALE[2], onset: true }], clock, 50);
  feed(follower, [{ freq: SCALE[3], onset: true }], clock, 50);
  assertEqual(follower.getState().current?.stepIndex ?? null, 3, "setup: extreme-fast-tempo advances landed at stepIndex 3");
  const traceLengthAfterSetup = follower.getTrace().length;

  const state = feed(follower, vibratoFrames(SCALE[3], 1.4, 150, 400), clock);

  assertEqual(state.current?.stepIndex ?? null, 3, "heavy vibrato never false-triggers, even at the floor-clamped window");
  assertEqual(follower.getTrace().length, traceLengthAfterSetup, "no NEW resync activity from the vibrato");
});

// 22. Interaction case -- at a slow established tempo (600ms/quarter-note), the adaptive window
// grows well past the static default (scaled to ~450ms here). A legato drift held for 240ms
// (already past the static 200ms default, but still short of the enlarged adaptive window) must
// NOT have triggered yet; a real onset arriving mid-wait must still take precedence immediately
// via the ordinary fast path, exactly as scenario 11 already guarantees -- now specifically
// exercised while the implicit watcher's (enlarged) window is still open, to confirm growing the
// window doesn't introduce any race with real-onset precedence.
scenario("22. slow tempo grows the window without breaking real-onset precedence mid-wait", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 6));
  const follower = new ScoreFollower(cursor, { adaptiveStabilityWindowEnabled: true });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 600);
  feed(follower, [{ freq: SCALE[2], onset: true }], clock, 600);
  feed(follower, [{ freq: SCALE[3], onset: true }], clock, 600);
  assertEqual(follower.getState().current?.stepIndex ?? null, 3, "setup: slow-tempo advances landed at stepIndex 3");
  const traceLengthAfterSetup = follower.getTrace().length;

  const midWait = feed(follower, legatoDriftFrames(SCALE[4], 25), clock);
  assertEqual(midWait.current?.stepIndex ?? null, 3, "still waiting -- hasn't reached the enlarged adaptive window yet");
  assertEqual(follower.getTrace().length, traceLengthAfterSetup, "no NEW implicit trigger has fired yet");

  const afterRealOnset = feed(follower, [{ freq: SCALE[4], onset: true }], clock, 10);
  assertEqual(afterRealOnset.current?.stepIndex ?? null, 4, "real onset resolves immediately via the fast path");
  assertEqual(follower.getTrace().at(-1)?.triggerSource, "onset", "resolved via the real onset, not the implicit watcher");
});

// 23. Kill-switch-off regression guard -- the SAME fast-tempo setup and 170ms drift as scenario
// 20, but with adaptiveStabilityWindowEnabled left at its default (false). Confirms tempo samples
// are harmlessly recorded in the background regardless (recordTempoSample runs unconditionally)
// but never actually used unless the flag is on -- the static 200ms default still governs, and
// 170ms hasn't reached it yet.
scenario("23. adaptiveStabilityWindowEnabled off (default) ignores tempo entirely", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 8));
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 100);
  feed(follower, [{ freq: SCALE[2], onset: true }], clock, 100);
  feed(follower, [{ freq: SCALE[3], onset: true }], clock, 100);
  assertEqual(follower.getState().current?.stepIndex ?? null, 3, "setup: fast-tempo advances landed at stepIndex 3");
  const traceLengthAfterSetup = follower.getTrace().length;

  const state = feed(follower, legatoDriftFrames(SCALE[4], 18), clock);

  assertEqual(state.current?.stepIndex ?? null, 3, "does not trigger -- 170ms hasn't reached the static 200ms default");
  assertEqual(follower.getTrace().length, traceLengthAfterSetup, "no NEW resync activity yet (still accumulating toward the static threshold)");
});

// 24. Direct regression guard for energyOnsetFusionEnabled -- a "low" fusion-confidence onset
// (audio/captureModule/index.ts's flux/energy voting; only one detector fired) opens a pending
// transition with pendingTransitionWindowMs(100) + lowConfidenceOnsetExtraSettleMs(80) = 180ms of
// patience before giving up. A valid, matching reading arriving 130ms after the onset (past the
// BASE deadline, well within the EXTENDED one) must still resolve via the ordinary fast path.
scenario("24. low-confidence onset gets extra settle time, letting a late reading still resolve", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 3));
  const follower = new ScoreFollower(cursor, {
    pendingTransitionWindowMs: 100,
    lowConfidenceOnsetExtraSettleMs: 80,
    energyOnsetFusionEnabled: true
  });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: null, onset: true, onsetConfidence: "low" }], clock, 10);
  feed(follower, Array.from({ length: 12 }, () => ({ freq: null })), clock);

  const state = feed(follower, [{ freq: SCALE[1] }], clock);
  assertEqual(state.current?.stepIndex ?? null, 1, "late reading (130ms after onset) still resolves via the extended deadline");
  assertEqual(follower.getTrace().at(-1)?.reason, "next_note_immediate", "resolved via the ordinary fast path");
});

// 25. Adversarial/false-positive guard -- SAME timing as scenario 24, but the onset is "high"
// fusion confidence. extraSettleMsFor() returns 0 regardless of energyOnsetFusionEnabled for
// "high", so the deadline must stay at the BASE 100ms -- the late (130ms) reading must NOT
// resolve; the transition must have already given up via deadline_expired. Guards that the
// common/majority case (a confidently double-detected onset) gets zero behavior change.
scenario("25. high-confidence onset is unaffected -- no extra settle time even with fusion on", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 3));
  const follower = new ScoreFollower(cursor, {
    pendingTransitionWindowMs: 100,
    lowConfidenceOnsetExtraSettleMs: 80,
    energyOnsetFusionEnabled: true
  });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: null, onset: true, onsetConfidence: "high" }], clock, 10);
  feed(follower, Array.from({ length: 12 }, () => ({ freq: null })), clock);

  const state = feed(follower, [{ freq: SCALE[1] }], clock);
  assertEqual(state.current?.stepIndex ?? null, 0, "late reading does not resolve -- deadline already expired at the base 100ms");
  assertEqual(follower.getTrace().at(-1)?.reason, "deadline_expired", "gave up at the unextended deadline");
});

// 26. Interaction case -- a low-confidence onset opens an extended (180ms) window, but a FRESH
// onset arrives before it resolves with "high" confidence instead. The window must shrink back
// down to reflect the NEW onset's confidence (deadline re-derived to the base 100ms from the
// second onset's own timestamp, per onLiveFrame's "always take the latest" extension logic), not
// stay stuck at the first onset's extended 180ms -- confirming the confidence value itself gets
// updated on extension, not just read once when the transition first opened.
scenario("26. a fresh higher-confidence onset shrinks the window back down, not stuck at the old extension", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 3));
  const follower = new ScoreFollower(cursor, {
    pendingTransitionWindowMs: 100,
    lowConfidenceOnsetExtraSettleMs: 80,
    energyOnsetFusionEnabled: true
  });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  // First onset: low confidence, at t=20 -- would extend the deadline to 20+100+80=200 if it were
  // the only one.
  feed(follower, [{ freq: null, onset: true, onsetConfidence: "low" }], clock, 10);
  // Second onset 40ms later (t=60): high confidence -- re-derives the deadline to 60+100+0=160,
  // strictly shorter than the first onset's own 200 would have been.
  feed(follower, Array.from({ length: 4 }, () => ({ freq: null })), clock);
  feed(follower, [{ freq: null, onset: true, onsetConfidence: "high" }], clock, 10);

  // Push well past the re-derived 160ms deadline but still short of the stale 200ms one -- if the
  // confidence update didn't take effect, this would incorrectly still be pending.
  const state = feed(follower, Array.from({ length: 11 }, () => ({ freq: null })), clock); // reaches t=170
  assertEqual(state.current?.stepIndex ?? null, 0, "expired at the re-derived (shorter) deadline");
  assertEqual(follower.getTrace().at(-1)?.reason, "deadline_expired", "gave up once the SECOND onset's own deadline passed");
});

// 27. Kill-switch-off regression guard -- identical setup and timing to scenario 24 (a
// low-confidence onset, a reading arriving 130ms later), but energyOnsetFusionEnabled left at its
// default (false). onsetConfidence data still flows through LivePitchFrame -- computing it is
// always-on in the audio layer -- but ScoreFollower must completely ignore it: the deadline stays
// at the base 100ms and the late reading does not resolve, identical to pre-Phase-3 behavior.
scenario("27. energyOnsetFusionEnabled off (default) ignores onset confidence entirely", () => {
  const cursor = createMockScoreCursor(SCALE.slice(0, 3));
  const follower = new ScoreFollower(cursor, { pendingTransitionWindowMs: 100 });
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: null, onset: true, onsetConfidence: "low" }], clock, 10);
  feed(follower, Array.from({ length: 12 }, () => ({ freq: null })), clock);

  const state = feed(follower, [{ freq: SCALE[1] }], clock);
  assertEqual(state.current?.stepIndex ?? null, 0, "does not resolve -- onsetConfidence is ignored with the flag off");
  assertEqual(follower.getTrace().at(-1)?.reason, "deadline_expired", "gave up at the base 100ms deadline, unaffected by confidence data");
});

// 28. Direct regression guard for fuzzySequenceMaxSkips > 1 -- targets the concrete limitation
// live testing found in Phase 1 (deletion-tolerance bridging only a single missed note): a gap of
// TWO consecutive missed notes. Layout: [current(0), filler(1), R1(2), skip1(3), skip2(4), R2(5),
// nextNote(6), filler(7), R1_dup(8), filler(9), filler(10), filler(11), R2_dup(12)]. R1 is
// ambiguous alone (offset+2 and +8); R1_dup/R2_dup are deliberately 4 apart (needing 3 skips,
// beyond maxSkips=2), so only the REAL two-skip bridge at start=2 can succeed.
scenario("28. fuzzySequenceMaxSkips=2 bridges a two-consecutive-missed-note gap", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const r1 = noteFreq(8);
  const skip1 = noteFreq(12);
  const skip2 = noteFreq(16);
  const r2 = noteFreq(20);
  const nextNote = noteFreq(24);
  const filler2 = noteFreq(28);
  const r1Dup = r1;
  const filler3 = noteFreq(32);
  const filler4 = noteFreq(36);
  const filler5 = noteFreq(40);
  const r2Dup = r2;
  const cursor = createMockScoreCursor([
    current,
    filler1,
    r1,
    skip1,
    skip2,
    r2,
    nextNote,
    filler2,
    r1Dup,
    filler3,
    filler4,
    filler5,
    r2Dup
  ]);
  const follower = new ScoreFollower(cursor, {
    resyncWindowAhead: 12,
    resyncWindowBehind: 1,
    fuzzySequenceMatchingEnabled: true,
    fuzzySequenceMaxSkips: 2
  });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  feed(follower, onsetFrames(r1), clock);
  assertEqual(follower.getTrace().at(-1)?.reason, "sequence_ambiguous", "R1 alone is ambiguous, waits");

  const state = feed(follower, onsetFrames(r2), clock);
  assertEqual(state.current?.stepIndex ?? null, 5, "resolves to R2's real position, spanning the two skipped notes");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.reason, "sequence_confirmed", "resolved as a confirmed sequence match");
  assertEqual(last?.offset, 5, "committed offset is +5 (spans both skipped notes)");
  assertEqual(last?.editDistance, 2, "used exactly 2 skips");
});

// 29. Boundary guard -- the SAME two-skip-gap layout as scenario 28, but with
// fuzzySequenceMaxSkips left at its default (1). Confirms the default still can't bridge a gap
// this size (matches the documented, live-confirmed Phase 1 boundary): falls back to the old
// solo-retry-on-R2-alone path, which is itself ambiguous here (R2 also has a duplicate), so R1 is
// discarded and nothing resolves -- proving fuzzySequenceMaxSkips is a deliberate opt-in bump, not
// a silent change to what already shipped.
scenario("29. default fuzzySequenceMaxSkips (1) still cannot bridge a two-note gap", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const r1 = noteFreq(8);
  const skip1 = noteFreq(12);
  const skip2 = noteFreq(16);
  const r2 = noteFreq(20);
  const nextNote = noteFreq(24);
  const filler2 = noteFreq(28);
  const r1Dup = r1;
  const filler3 = noteFreq(32);
  const filler4 = noteFreq(36);
  const filler5 = noteFreq(40);
  const r2Dup = r2;
  const cursor = createMockScoreCursor([
    current,
    filler1,
    r1,
    skip1,
    skip2,
    r2,
    nextNote,
    filler2,
    r1Dup,
    filler3,
    filler4,
    filler5,
    r2Dup
  ]);
  const follower = new ScoreFollower(cursor, {
    resyncWindowAhead: 12,
    resyncWindowBehind: 1,
    fuzzySequenceMatchingEnabled: true
  });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  feed(follower, onsetFrames(r1), clock);
  const state = feed(follower, onsetFrames(r2), clock);

  assertEqual(state.current?.stepIndex ?? null, 0, "cursor stays stranded -- default cap can't bridge a 2-note gap");
  assertEqual(follower.getTrace().at(-1)?.reason, "sequence_ambiguous", "falls back to the old ambiguous solo-retry path");
});

// 30. Adversarial/false-positive guard -- with fuzzySequenceMaxSkips=2, verifies ranking prefers
// FEWER skips, not just any successful match. Layout: [current(0), filler(1), X(2), skip_a(3),
// Y(4), filler(5), X_dup(6), skip_b(7), skip_c(8), Y_dup(9), filler(10)]. Playing [X,Y] has a
// genuine 1-skip bridge at offset+2 (X immediately followed, after one skip, by Y) AND a
// coincidental 2-skip bridge at offset+6 (X_dup, two skips, Y_dup). The 1-skip match must win --
// if ranking were skip-count-blind (any successful match treated equally), the two could tie or
// the wrong one could be picked.
scenario("30. ranking prefers a 1-skip match over a coincidental 2-skip one", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const x = noteFreq(8);
  const skipA = noteFreq(12);
  const y = noteFreq(16);
  const filler2 = noteFreq(20);
  const xDup = x;
  const skipB = noteFreq(24);
  const skipC = noteFreq(28);
  const yDup = y;
  const filler3 = noteFreq(32);
  const cursor = createMockScoreCursor([current, filler1, x, skipA, y, filler2, xDup, skipB, skipC, yDup, filler3]);
  const follower = new ScoreFollower(cursor, {
    resyncWindowAhead: 10,
    resyncWindowBehind: 1,
    fuzzySequenceMatchingEnabled: true,
    fuzzySequenceMaxSkips: 2
  });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  feed(follower, onsetFrames(x), clock);
  assertEqual(follower.getTrace().at(-1)?.reason, "sequence_ambiguous", "X alone is ambiguous (real + dup)");

  const state = feed(follower, onsetFrames(y), clock);
  assertEqual(state.current?.stepIndex ?? null, 4, "lands on the 1-skip match (stepIndex 4), not the 2-skip one (stepIndex 9)");
  const last = follower.getTrace().at(-1);
  assertEqual(last?.editDistance, 1, "resolved via the cheaper 1-skip match");
});

// 31. Interaction case -- reuses scenario 28's two-skip layout, then drifts (no onset) from the
// multi-skip-resolved landing note to the next one, exercising the same commitAdvance ->
// beginTrackingCurrentNote -> implicitOnsetWatcher.reset() path as scenario 18, now for a
// multi-skip (not just single-skip) commit.
scenario("31. implicit trigger still works normally right after a multi-skip resync commit", () => {
  const current = noteFreq(0);
  const filler1 = noteFreq(4);
  const r1 = noteFreq(8);
  const skip1 = noteFreq(12);
  const skip2 = noteFreq(16);
  const r2 = noteFreq(20);
  const nextNote = noteFreq(24);
  const filler2 = noteFreq(28);
  const r1Dup = r1;
  const filler3 = noteFreq(32);
  const filler4 = noteFreq(36);
  const filler5 = noteFreq(40);
  const r2Dup = r2;
  const cursor = createMockScoreCursor([
    current,
    filler1,
    r1,
    skip1,
    skip2,
    r2,
    nextNote,
    filler2,
    r1Dup,
    filler3,
    filler4,
    filler5,
    r2Dup
  ]);
  const follower = new ScoreFollower(cursor, {
    resyncWindowAhead: 12,
    resyncWindowBehind: 1,
    fuzzySequenceMatchingEnabled: true,
    fuzzySequenceMaxSkips: 2
  });
  follower.start();
  const clock = { t: 0 };
  feed(follower, [{ freq: current, onset: true }, { freq: current }], clock);

  feed(follower, onsetFrames(r1), clock);
  const afterMultiSkipResync = feed(follower, onsetFrames(r2), clock);
  assertEqual(afterMultiSkipResync.current?.stepIndex ?? null, 5, "setup: multi-skip resync landed on stepIndex 5");

  const afterImplicit = feed(follower, legatoDriftFrames(nextNote), clock);
  assertEqual(afterImplicit.current?.stepIndex ?? null, 6, "implicit trigger advances normally afterward");
  assertEqual(follower.getTrace().at(-1)?.triggerSource, "implicit", "resolved via the implicit trigger, unaffected by the prior multi-skip commit");
});

// 32. Direct regression guard for NoteAccuracyRecord.inferredFromRepeat -- a same-pitch repeated
// note (e.g. "Twinkle Twinkle"'s "D D") that gets zero samples of its own (two back-to-back
// onsets with no settled frames between them, so there's never a chance to collect any) inherits
// the immediately preceding, identically-pitched note's verdict instead of silently reporting
// "not_played" for a note that genuinely was played.
scenario("32. same-pitch repeat with no samples inherits the previous note's verdict", () => {
  const cursor = createMockScoreCursor([SCALE[0], SCALE[1], SCALE[1], SCALE[2]]);
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 10);
  // Settled frames at exactly SCALE[1] -- 0 cents off, comfortably "in_tune".
  feed(follower, Array.from({ length: 8 }, () => ({ freq: SCALE[1] })), clock);

  // Two back-to-back onsets with NO intervening settled frames -- the second SCALE[1] (stepIndex
  // 2) never gets a chance to collect any samples of its own.
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[2], onset: true }], clock, 10);

  const state = follower.getState();
  const repeat1 = state.history.find((r) => r.stepIndex === 1);
  const repeat2 = state.history.find((r) => r.stepIndex === 2);
  assertEqual(repeat1?.verdict, "in_tune", "setup: first repeat measured in tune");
  assert((repeat1?.centsOffSamples.length ?? 0) > 0, "setup: first repeat actually got samples of its own");
  assertEqual(repeat2?.centsOffSamples.length, 0, "confirms the second repeat genuinely got zero samples");
  assertEqual(repeat2?.verdict, "in_tune", "second repeat inherits the first's verdict");
  assertEqual(repeat2?.averageCentsOff, repeat1?.averageCentsOff, "second repeat inherits the exact cents value too");
  assertEqual(repeat2?.inferredFromRepeat, true, "flagged as inferred, not a real measurement");
});

// 33. Adversarial/false-positive guard -- same setup as scenario 32, but the second note is a
// DIFFERENT pitch. Must NOT inherit the previous verdict; exact-frequency equality is required,
// not "any nearby unmeasured note."
scenario("33. a different-pitch note with no samples does NOT inherit the previous verdict", () => {
  const cursor = createMockScoreCursor([SCALE[0], SCALE[1], SCALE[2], SCALE[3]]);
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 10);
  feed(follower, Array.from({ length: 8 }, () => ({ freq: SCALE[1] })), clock);

  feed(follower, [{ freq: SCALE[2], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[3], onset: true }], clock, 10);

  const state = follower.getState();
  const first = state.history.find((r) => r.stepIndex === 1);
  const second = state.history.find((r) => r.stepIndex === 2);
  assertEqual(first?.verdict, "in_tune", "setup: first note measured in tune");
  assertEqual(second?.verdict, "not_played", "different pitch -- stays not_played, no inference");
  assertEqual(second?.inferredFromRepeat, false, "not flagged as inferred");
});

// 34. Interaction/boundary guard -- an unmeasured note must not chain-infer from an equally
// unmeasured (not_played) neighbor, even at the same pitch, and the very first note in history
// (no previous entry at all) must not crash or misbehave.
scenario("34. an unmeasured note does not chain-infer from an equally unmeasured neighbor", () => {
  const cursor = createMockScoreCursor([SCALE[0], SCALE[1], SCALE[1]]);
  const follower = new ScoreFollower(cursor);
  follower.start();
  const clock = { t: 0 };

  // Every onset back-to-back, no settled frames anywhere -- stepIndex 0 and 1 both get zero
  // samples of their own.
  feed(follower, [{ freq: SCALE[0], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 10);
  feed(follower, [{ freq: SCALE[1], onset: true }], clock, 10);
  follower.stop();

  const state = follower.getState();
  const first = state.history.find((r) => r.stepIndex === 0);
  const second = state.history.find((r) => r.stepIndex === 1);
  assertEqual(first?.verdict, "not_played", "first note in history (no previous) stays not_played");
  assertEqual(first?.inferredFromRepeat, false, "not flagged as inferred");
  assertEqual(second?.verdict, "not_played", "second note does not chain-infer from an equally unmeasured neighbor");
  assertEqual(second?.inferredFromRepeat, false, "not flagged as inferred");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Resync harness failed.");
  process.exit(1);
}
