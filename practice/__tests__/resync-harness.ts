// Standalone scripted harness for ScoreFollower's bidirectional resync logic. There's no Jest/
// Vitest in this repo -- run via `npm run followerTest` (tsx, same pattern as
// audio/__tests__/offline-validation/runValidation.ts). Exercises ScoreFollower against a mock
// ScoreCursor (plain array, no OSMD/DOM dependency) with hand-built synthetic frame sequences, so
// resync/reattack/deadline outcomes are deterministic and don't require live mic input.
import { ScoreFollower, type ScoreFollowerConfig } from "../cursor";
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

function makeNote(stepIndex: number, freqHz: number): CursorNoteInfo {
  return {
    stepIndex,
    measureIndex: Math.floor(stepIndex / 4),
    frequenciesHz: [freqHz],
    primaryFrequencyHz: freqHz,
    pitchLabel: `N${stepIndex}`,
    isRest: false
  };
}

// Plain in-memory array standing in for OSMD's Cursor -- pure index arithmetic, implementing the
// full ScoreCursor contract (including the resync primitives) the same way
// score/renderer/scoreCursor.ts does against the real OSMD iterator.
function createMockScoreCursor(frequencies: number[]): ScoreCursor {
  const notes = frequencies.map((freq, i) => makeNote(i, freq));
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
    setHighlightColor(): void {}
  };
}

interface SimFrame {
  freq: number | null;
  onset?: boolean;
  silent?: boolean;
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
      onsetDetected: f.onset ?? false
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Resync harness failed.");
  process.exit(1);
}
