// Detects a note change that OnsetDetector's spectral-flux analysis missed (typically a
// legato/slurred bow change with no attack transient to catch) by watching for the pitch drifting
// away from the current note's expected frequency and *holding* there for a while, rather than
// requiring an attack event at all. Mirrors OnsetDetector's shape (stateful, fed one frame at a
// time, no dependency on ScoreFollower/ScoreCursor internals) so it composes the same way.
//
// Two independently-tuned tolerances, not one, because they answer different questions:
//   - stabilityToleranceSemitones: "has this reading left the OLD (departing) note?" Originally
//     kept tight so even a half-step legato transition would reliably register as drift, but live
//     testing found heavy/expressive violin vibrato can swing close to (or past) a semitone off
//     center, which got misread as an advance to the next note -- see this field's config doc
//     comment in cursor.ts for the resulting tradeoff (biased toward avoiding that false positive,
//     at the cost of no longer reliably catching half-step legato transitions this way).
//   - clusterToleranceSemitones: "is this reading still part of the SAME candidate NEW note I've
//     been accumulating?" Deliberately wider still, sized to absorb vibrato applied to the arrival
//     note without breaking the run apart -- a live-testing round found that comparing every
//     reading against every other reading in a fixed window (a "span" check) fails exactly here:
//     vibrato's own spread can exceed a tight tolerance well before minStableMs elapses, so the
//     run never survives long enough to trigger, defeating the fix for the vibrato case
//     specifically. A running centroid instead adapts to the note being held (vibrato averages
//     toward its true center over time), so individual swung readings get absorbed instead of
//     evicted.
export interface ImplicitOnsetWatcherConfig {
  minStableMs: number;
  stabilityToleranceSemitones: number;
  clusterToleranceSemitones: number;
}

export interface ImplicitOnsetUpdateResult {
  triggered: boolean;
  // Timestamp of the earliest frame in the confirmed-stable run -- becomes the implicit
  // transition's PendingTransition.onsetMs (backdated, not "now"). By construction this run has
  // already held for >= minStableMs, which exceeds attackSettleMs at default config, so the
  // transition is already "settled" the instant it opens.
  stableSinceMs: number | null;
  // True whenever this frame is part of an in-progress (not yet confirmed) drift candidate --
  // ScoreFollower uses this to pause cents-off sample collection against the *departing* note
  // while it's ambiguous whether these readings belong to it or to a note not yet recognized.
  hasActiveWindow: boolean;
}

function semitoneValue(frequencyHz: number): number {
  return 12 * Math.log2(frequencyHz);
}

// EMA smoothing factor for the running cluster centroid -- see the comment at its update site.
const CENTROID_SMOOTHING = 0.3;

interface RunEntry {
  timestampMs: number;
  semitoneValue: number;
}

export class ImplicitOnsetWatcher {
  private readonly config: ImplicitOnsetWatcherConfig;
  private run: RunEntry[] = [];
  // Running mean of run[].semitoneValue, kept incrementally rather than recomputed from the array
  // on every frame.
  private centroidSemitoneValue = 0;

  constructor(config: ImplicitOnsetWatcherConfig) {
    this.config = config;
  }

  reset(): void {
    this.run = [];
    this.centroidSemitoneValue = 0;
  }

  // referenceFrequencyHz is the CURRENT note's expected pitch -- what this watcher is trying to
  // detect drift AWAY from. Pass null (no current note, e.g. a rest or not yet started) to force
  // a reset; this frame contributes nothing.
  update(
    frequencyHz: number | null,
    timestampMs: number,
    isSilent: boolean,
    referenceFrequencyHz: number | null
  ): ImplicitOnsetUpdateResult {
    if (isSilent || frequencyHz === null || referenceFrequencyHz === null) {
      this.reset();
      return { triggered: false, stableSinceMs: null, hasActiveWindow: false };
    }

    const value = semitoneValue(frequencyHz);

    // Still within the departing note's own tuning/vibrato band -- not drifting, nothing to
    // accumulate. Resetting (not just skipping) on ANY single close reading is intentionally
    // aggressive: a momentary return toward `current` is itself evidence the player probably
    // hasn't left it yet. (Known tradeoff, not fixed here: pitch jitter that straddles this
    // boundary near a genuine transition could cause repeated resets and stall triggering --
    // watch for this in live testing before adding hysteresis, since it's a latency risk, not a
    // false-positive risk.)
    if (Math.abs(value - semitoneValue(referenceFrequencyHz)) <= this.config.stabilityToleranceSemitones) {
      this.reset();
      return { triggered: false, stableSinceMs: null, hasActiveWindow: false };
    }

    if (this.run.length === 0 || Math.abs(value - this.centroidSemitoneValue) > this.config.clusterToleranceSemitones) {
      // Either the first drifted reading, or this one doesn't belong to the run accumulated so
      // far (a genuinely different pitch -- a further note, a slide) -- start a fresh run rather
      // than evicting piecemeal from an old one.
      this.run = [{ timestampMs, semitoneValue: value }];
      this.centroidSemitoneValue = value;
    } else {
      this.run.push({ timestampMs, semitoneValue: value });
      // Exponential moving average, not a plain running mean over the whole run: a plain mean
      // stays anchored near wherever the run happened to start, which -- if that's near one
      // extreme of the arrival note's vibrato -- can lag far enough behind a later reading near
      // the OPPOSITE extreme to exceed clusterToleranceSemitones and wrongly reset the run before
      // vibrato has completed even one full cycle. An EMA "forgets" that initial bias within a
      // handful of frames and tracks the note's actual center much sooner.
      this.centroidSemitoneValue += CENTROID_SMOOTHING * (value - this.centroidSemitoneValue);
    }

    const stableSinceMs = this.run[0].timestampMs;
    const triggered = timestampMs - stableSinceMs >= this.config.minStableMs;
    if (triggered) {
      this.reset();
    }
    return { triggered, stableSinceMs: triggered ? stableSinceMs : null, hasActiveWindow: !triggered };
  }
}
