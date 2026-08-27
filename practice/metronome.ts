export function msPerBeat(config: { tempoBpm: number }): number {
  return 60_000 / config.tempoBpm;
}

// Converts a MusicXML-style time signature string ("4/4", "3/4", "6/8", ...) into a count of
// quarter notes per measure -- e.g. "6/8" is 6 * (4/8) = 3 quarter notes' worth of time, not 6 (a
// naive "just use the numerator" reading would get the total bar DURATION wrong for any measure
// whose beat unit isn't a quarter note). This is purely a duration computation -- it says nothing
// about how that duration should be SUBDIVIDED for click purposes; see ClickSubdivision for that.
// Falls back to 4 (a plain, unremarkable default) for a missing or malformed string.
//
// Deliberately NOT rounded to a whole number -- an odd numerator over an eighth-note beat type
// (9/8, 15/8, ...) genuinely lands on a half quarter-note (9/8 = 4.5), and rounding that away
// (confirmed live: Math.round(4.5) -> 5) silently added a whole extra click's worth of time to
// every such measure, most visibly as a spurious 10th click at the end of a 9/8 bar delaying the
// next bar's downbeat by one full beat. Safe to leave exact: every caller either multiplies by
// FINE_SUBDIVISIONS_PER_QUARTER (4, i.e. sixteenth-note resolution) before using the result, which
// an eighth-note-based fraction always divides evenly into, or explicitly rounds afterward itself
// (createBeatClock's own clicksPerMeasure) where an integer click count is actually required.
export function quarterNotesPerMeasure(timeSignature: string | undefined | null): number {
  if (!timeSignature) {
    return 4;
  }
  const [numeratorStr, denominatorStr] = timeSignature.split("/");
  const numerator = Number(numeratorStr);
  const denominator = Number(denominatorStr);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return 4;
  }
  return Math.max(0.25, numerator * (4 / denominator));
}

export interface TimeSignatureSegment {
  // Cumulative quarter notes from the start of the piece (not the count-in) at which this
  // signature takes over. A MusicXML time signature change always lands on a measure boundary,
  // so this is always exactly a measure start -- never mid-measure.
  startQuarterNote: number;
  timeSignature: string;
}

// Derives the ordered "this time signature starts here" sequence a BeatClock needs to keep its
// click's beat-grouping and downbeat position in sync with the score's own written meter changes,
// instead of assuming the piece stays in whatever it opened with for its entire duration.
// `measure.timeSignature` is only set where score/musicxmlImport.ts's importer detected a genuine
// (or, with its auto-correct-time-signatures option on, corrected) change -- any measure without
// one just continues the previous segment, and its own duration still needs to be walked using
// that carried-forward signature to keep later segments' start offsets correct.
export function computeTimeSignatureSegments(measures: ReadonlyArray<{ timeSignature?: string }>): TimeSignatureSegment[] {
  const segments: TimeSignatureSegment[] = [];
  let cumulativeQuarterNotes = 0;
  let currentTimeSignature: string | null = null;

  for (const measure of measures) {
    if (measure.timeSignature && measure.timeSignature !== currentTimeSignature) {
      currentTimeSignature = measure.timeSignature;
      segments.push({ startQuarterNote: cumulativeQuarterNotes, timeSignature: currentTimeSignature });
    }
    cumulativeQuarterNotes += quarterNotesPerMeasure(currentTimeSignature ?? "4/4");
  }

  return segments.length > 0 ? segments : [{ startQuarterNote: 0, timeSignature: "4/4" }];
}

// What the audible click (and count-in) actually ticks on. "auto" picks a musically conventional
// default from the time signature (see resolveClickSubdivision()) -- plain quarter notes for
// simple meters, but the DOTTED quarter for compound meters (6/8, 9/8, 12/8, ...), since that's
// the actual felt beat there, not a plain quarter. A fixed "quarter" always ticks 6 times in a
// 12/8 bar regardless of convention -- musically wrong for that meter (confirmed live: reported
// as "didn't work at all," not just "counted wrong"), which is why this needs to be a real choice
// rather than always auto-derived: a piece with genuinely notated-against-the-quarter phrasing in
// a compound meter, or a user who just prefers a different click density, can override it.
export type ClickSubdivision = "auto" | "quarter" | "dottedQuarter" | "eighth";

export interface MetronomeConfig {
  tempoBpm: number;
  // The piece's full sequence of meter changes (see computeTimeSignatureSegments()) -- used for
  // the count-in bar's duration (always the first segment's signature, since the count-in
  // precedes anything the piece itself has played), and per-segment for both clicksPerMeasure/
  // downbeat position and, when clickSubdivision is "auto", the click subdivision. Must be
  // non-empty and sorted ascending by startQuarterNote, with the first entry at 0 --
  // computeTimeSignatureSegments() already guarantees both. This clock does NOT also follow
  // per-measure tempo changes (ScoreMeasure.tempoBpm) -- tempoBpm here is a single fixed value
  // for the whole session, a separate and not-yet-addressed scope boundary from the meter
  // tracking this type exists for.
  timeSignatureSegments: TimeSignatureSegment[];
  clickSubdivision: ClickSubdivision;
}

// Compound meter: denominator 8, numerator a multiple of 3, at least 6 (6/8, 9/8, 12/8, ...) --
// the conventional felt beat there is a dotted quarter (a group of 3 eighth notes), not a plain
// quarter. Anything else (2/4, 3/4, 4/4, 2/2, 5/8 non-compound groupings, ...) defaults to a
// plain quarter, which is what this app's BPM already means everywhere else (ScoreDocument.tempoBpm,
// MetronomeScoreFollower's own scheduling).
function resolveClickSubdivision(
  subdivision: ClickSubdivision,
  timeSignature: string | undefined | null
): "quarter" | "dottedQuarter" | "eighth" {
  if (subdivision !== "auto") {
    return subdivision;
  }
  if (!timeSignature) {
    return "quarter";
  }
  const [numeratorStr, denominatorStr] = timeSignature.split("/");
  const numerator = Number(numeratorStr);
  const denominator = Number(denominatorStr);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator === 8 && numerator >= 6 && numerator % 3 === 0) {
    return "dottedQuarter";
  }
  return "quarter";
}

// Cursor advancement and the audible click both originate from THIS clock now, not from two
// independently-scheduled systems -- see BeatClockOptions.onTick's doc comment for why. Internally
// ticks at sixteenth-note resolution (FINE_SUBDIVISIONS_PER_QUARTER) regardless of click
// subdivision, so a note shorter than a full click interval (e.g. an eighth note under a
// dotted-quarter click) still lands on an accurate boundary -- only the AUDIBLE click's density
// changes with clickSubdivision, never the underlying scheduling precision.
const FINE_SUBDIVISIONS_PER_QUARTER = 4;

function fineTicksPerClick(subdivision: "quarter" | "dottedQuarter" | "eighth"): number {
  switch (subdivision) {
    case "eighth":
      return FINE_SUBDIVISIONS_PER_QUARTER / 2;
    case "dottedQuarter":
      return FINE_SUBDIVISIONS_PER_QUARTER * 1.5;
    case "quarter":
    default:
      return FINE_SUBDIVISIONS_PER_QUARTER;
  }
}

// Small, fixed lookahead-scheduler constants (the standard "schedule audio events slightly ahead
// of an interval-driven poll" pattern -- a naive one-setTimeout-per-click approach drifts/jitters
// noticeably over a multi-minute piece, since setTimeout itself is only approximately accurate).
const SCHEDULE_AHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
const CLICK_DURATION_SECONDS = 0.05;
const DOWNBEAT_FREQUENCY_HZ = 1600;
const OFFBEAT_FREQUENCY_HZ = 1000;
// If the scheduler ever finds itself more than this far BEHIND the AudioContext's own clock (the
// tab was backgrounded and the browser suspended/throttled audio processing, a GC pause, etc.),
// resync forward instead of firing every "overdue" tick back-to-back. Without this, a suspend/
// resume gap made the while loop below schedule a burst of oscillators whose requested start
// times had already passed -- Web Audio clamps a past start time to "now," so several oscillators
// at slightly different pitches all started at once, which is exactly what produced the
// dissonant/"broken bass noise" sound reported live. Resyncing forward instead means a big gap
// behaves like practice was simply paused, not like a burst of noise.
const MAX_CATCHUP_GAP_SECONDS = 1.5;

export interface BeatClockOptions {
  // Whether the audible click continues (on click-subdivision-aligned ticks) after the count-in
  // bar finishes, not just during it.
  continueClicking: boolean;
  // Fires exactly once, at the real-time instant the count-in bar finishes (right when the "real"
  // first beat begins) -- start the actual MetronomeScoreFollower session from inside this
  // callback, not before, so the follower's very first note begins at the same instant this clock
  // considers beat 1 to have started.
  onCountInComplete: () => void;
  // Fires once per fine (sixteenth-note) tick, starting from the SAME instant onCountInComplete
  // fires and continuing every tick after that until stop() is called. This is now the ONLY
  // mechanism that drives MetronomeScoreFollower.advanceOnTick() -- previously the click player
  // and the follower's own cursor-advancement timer were two independently-clocked systems (the
  // click scheduled against this module's AudioContext, the follower scheduled against
  // microphone-input frame timestamps from a DIFFERENT AudioContext), and no amount of tuning
  // could fully close the gap between them since they were never actually the same clock to begin
  // with. Routing cursor advancement through this same callback instead means the audible click
  // and the visible cursor move literally cannot disagree about timing -- both are reactions to
  // the same scheduled event, not separately-derived approximations of "the same" instant.
  // Always fires with quarterNotesElapsed = 1/FINE_SUBDIVISIONS_PER_QUARTER; passed explicitly
  // (rather than the follower importing the constant) to keep the two modules decoupled.
  onTick: (quarterNotesElapsed: number) => void;
  // Fires at the real-time instant an audible click actually starts playing (count-in clicks
  // included). The click plays through the same speakers the microphone can pick up, and a clean
  // sine-wave click reads as a confidently-detected pitch to the violin pitch detector -- there is
  // no way to distinguish "the metronome's own click" from "a real note" in the audio signal
  // itself without knowing WHEN it was scheduled. MetronomeScoreFollower.notifyClickPlayed()
  // (called from here) is what actually masks it out.
  onClick?: () => void;
}

export interface BeatClock {
  start(options: BeatClockOptions): void;
  stop(): void;
}

interface SegmentRuntime {
  startQuarterNote: number;
  fineTicksPerClickValue: number;
  clicksPerMeasure: number;
}

// Tolerance for the "which segment is this tick in" lookup below -- elapsedQuarterNotes is
// derived from an integer tick count divided by FINE_SUBDIVISIONS_PER_QUARTER, and segment
// startQuarterNote values are sums of quarterNotesPerMeasure() results, so both are exact
// multiples of a small fraction in practice, but this guards against float drift regardless.
const SEGMENT_LOOKUP_EPSILON = 1e-6;

export function createBeatClock(config: MetronomeConfig): BeatClock {
  const secondsPerQuarterNote = msPerBeat(config) / 1000;
  const secondsPerFineTick = secondsPerQuarterNote / FINE_SUBDIVISIONS_PER_QUARTER;

  const sortedSegments = [...config.timeSignatureSegments].sort((a, b) => a.startQuarterNote - b.startQuarterNote);
  const effectiveSegments = sortedSegments.length > 0 ? sortedSegments : [{ startQuarterNote: 0, timeSignature: "4/4" }];
  // Per-segment click/downbeat parameters, precomputed once up front rather than per-tick --
  // each segment gets its own resolved subdivision (so "auto" mode correctly switches between
  // plain and dotted-quarter clicks as the piece moves between simple and compound meters) and
  // its own clicksPerMeasure (derived from that segment's ACTUAL bar duration, same reasoning as
  // the single-signature version this replaced).
  const segmentRuntimes: SegmentRuntime[] = effectiveSegments.map((segment) => {
    const resolvedSubdivision = resolveClickSubdivision(config.clickSubdivision, segment.timeSignature);
    const ticksPerClick = fineTicksPerClick(resolvedSubdivision);
    const measureFineTicks = quarterNotesPerMeasure(segment.timeSignature) * FINE_SUBDIVISIONS_PER_QUARTER;
    return {
      startQuarterNote: segment.startQuarterNote,
      fineTicksPerClickValue: ticksPerClick,
      clicksPerMeasure: Math.max(1, Math.round(measureFineTicks / ticksPerClick))
    };
  });

  // The count-in bar always follows the piece's OPENING meter -- it happens before the piece's
  // own first measure begins, so there's no other segment it could sensibly be counting in.
  const countInSegment = segmentRuntimes[0];
  const countInTickCount = countInSegment.clicksPerMeasure * countInSegment.fineTicksPerClickValue;

  let audioContext: AudioContext | null = null;
  let schedulerHandle: number | null = null;
  let nextTickTime = 0;
  let tickIndex = 0;
  let options: BeatClockOptions | null = null;
  // One real-time-fire timeout per scheduled-ahead tick (not just a single count-in timeout like
  // an earlier version) -- tracked so stop() can cancel every last one of them, including any
  // already scheduled slightly ahead of the current audio time.
  const pendingTimeoutHandles = new Set<number>();

  // Which segment tick `index` falls in -- the count-in always uses countInSegment; once the real
  // piece starts (index >= countInTickCount), converts elapsed ticks since then into elapsed
  // quarter notes and finds the last segment whose startQuarterNote has been reached. segmentRuntimes
  // is sorted ascending, so the last match by simple forward scan is the correct (most recent) one.
  function activeSegmentRuntime(index: number): SegmentRuntime {
    if (index < countInTickCount) {
      return countInSegment;
    }
    const elapsedQuarterNotes = (index - countInTickCount) / FINE_SUBDIVISIONS_PER_QUARTER;
    let active = segmentRuntimes[0];
    for (const segment of segmentRuntimes) {
      if (segment.startQuarterNote > elapsedQuarterNotes + SEGMENT_LOOKUP_EPSILON) {
        break;
      }
      active = segment;
    }
    return active;
  }

  // Fine ticks since `segment` itself started (not since the clock started) -- click/downbeat
  // boundaries are always counted relative to the segment's own start, which is always exactly a
  // measure boundary (see TimeSignatureSegment's doc comment), so this never needs to account for
  // a mid-measure meter change.
  function segmentRelativeFineTicks(index: number, segment: SegmentRuntime): number {
    if (index < countInTickCount) {
      return index;
    }
    const elapsedQuarterNotes = (index - countInTickCount) / FINE_SUBDIVISIONS_PER_QUARTER;
    return Math.round((elapsedQuarterNotes - segment.startQuarterNote) * FINE_SUBDIVISIONS_PER_QUARTER);
  }

  function scheduleClick(time: number, isDownbeat: boolean): void {
    if (!audioContext) {
      return;
    }
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = isDownbeat ? DOWNBEAT_FREQUENCY_HZ : OFFBEAT_FREQUENCY_HZ;
    // Short, sharp envelope for a "tick" rather than a tone -- instant near-zero start, a fast
    // linear rise to avoid a click/pop from a discontinuous jump, then an exponential decay
    // (exponentialRampToValueAtTime can't target exactly 0, hence the 0.0001 floor).
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(isDownbeat ? 0.35 : 0.22, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + CLICK_DURATION_SECONDS);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(time);
    oscillator.stop(time + CLICK_DURATION_SECONDS + 0.02);
  }

  // Runs at the real-time instant `index`'s tick was scheduled for -- the single place
  // onCountInComplete, onTick, and onClick all actually fire from. Combined into one callback
  // (rather than independently-scheduled timeouts landing on the same nominal instant) so their
  // relative order can never race: onClick and onCountInComplete are guaranteed to run and return
  // before this tick's onTick call, every time.
  function fireTickCallback(index: number, hasClick: boolean): void {
    if (!options) {
      return;
    }
    if (hasClick) {
      options.onClick?.();
    }
    if (index === countInTickCount) {
      options.onCountInComplete();
    }
    if (index >= countInTickCount) {
      options.onTick(1 / FINE_SUBDIVISIONS_PER_QUARTER);
    }
  }

  function scheduleTickCallback(index: number, delaySeconds: number, hasClick: boolean): void {
    const handle = window.setTimeout(
      () => {
        pendingTimeoutHandles.delete(handle);
        fireTickCallback(index, hasClick);
      },
      Math.max(0, delaySeconds * 1000)
    );
    pendingTimeoutHandles.add(handle);
  }

  function tick(): void {
    if (!audioContext || !options) {
      return;
    }

    // A suspended context's currentTime is frozen -- this is what silently stopped the click
    // entirely in the field ("randomly stops making noise"), since the while loop's own condition
    // (nextTickTime < currentTime + lookahead) simply never becomes true again once currentTime
    // stops advancing. Nothing else in this module can detect that on its own; resuming here, on
    // every scheduler poll, is what recovers from it automatically.
    if (audioContext.state === "suspended") {
      void audioContext.resume();
      return;
    }

    if (nextTickTime < audioContext.currentTime - MAX_CATCHUP_GAP_SECONDS) {
      nextTickTime = audioContext.currentTime + 0.05;
    }

    while (nextTickTime < audioContext.currentTime + SCHEDULE_AHEAD_SECONDS) {
      const index = tickIndex;
      const segment = activeSegmentRuntime(index);
      const relativeFineTicks = segmentRelativeFineTicks(index, segment);
      const clickBoundary = relativeFineTicks % segment.fineTicksPerClickValue === 0;
      const inCountIn = index < countInTickCount;
      const isDownbeat = clickBoundary && (relativeFineTicks / segment.fineTicksPerClickValue) % segment.clicksPerMeasure === 0;
      const hasClick = clickBoundary && (inCountIn || options.continueClicking);

      if (hasClick) {
        scheduleClick(nextTickTime, isDownbeat);
      }
      scheduleTickCallback(index, nextTickTime - audioContext.currentTime, hasClick);

      tickIndex += 1;
      nextTickTime += secondsPerFineTick;
    }
  }

  return {
    start(startOptions) {
      options = startOptions;
      tickIndex = 0;
      // TEMPORARY diagnostic -- confirms the full per-segment breakdown a mid-piece meter change
      // relies on, not just the opening signature. Remove once mid-piece meter changes are
      // confirmed working live against a real piece that has them.
      console.debug(
        `[metronome] clickSubdivision=${config.clickSubdivision} countInTickCount=${countInTickCount} segments=${JSON.stringify(
          effectiveSegments.map((segment, i) => ({ ...segment, ...segmentRuntimes[i] }))
        )}`
      );
      // Created fresh per session rather than reused -- start() only ever runs from a user
      // gesture (the "Practice this score" click), which satisfies every browser's autoplay
      // policy for a new AudioContext.
      audioContext = new AudioContext();
      nextTickTime = audioContext.currentTime + 0.05;
      schedulerHandle = window.setInterval(tick, SCHEDULER_INTERVAL_MS);
      tick();
    },
    stop() {
      if (schedulerHandle !== null) {
        window.clearInterval(schedulerHandle);
        schedulerHandle = null;
      }
      for (const handle of pendingTimeoutHandles) {
        window.clearTimeout(handle);
      }
      pendingTimeoutHandles.clear();
      options = null;
      const context = audioContext;
      audioContext = null;
      void context?.close();
    }
  };
}
