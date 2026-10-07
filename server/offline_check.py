"""Offline sanity checks for the Matchmaker alignment service.

Run manually (``python server/offline_check.py``), not part of any automated suite -- same
convention as the Node side's ``npm run phase0:validate`` and ``npm run followerTest``: this repo
has no test framework, and correctness for signal-path code is checked by harnesses that feed real
or synthetic audio through the real code path.

What this CANNOT cover: the browser half. getUserMedia, the worklet, the HTTPS/Vite ``/ws`` proxy
hop, and the cursor wiring all need a live session. A clean run here is necessary, not sufficient.
"""

from __future__ import annotations

import sys
import time
import warnings
import wave
from pathlib import Path

import numpy as np

# partitura warns on every load about ignore_invisible_objects and unhandled metronome directions;
# neither is actionable here and both drown the actual results.
warnings.filterwarnings("ignore", module="partitura")
warnings.filterwarnings("ignore", module="librosa")

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from matchmaker_service import (  # noqa: E402
    FRAME_RATE,
    LiveAligner,
    convert_beat_to_quarter,
    write_score,
)

REPO_ROOT = BASE_DIR.parent
DATASET_DIR = REPO_ROOT / "audio" / "__tests__" / "offline-validation" / "dataset"

failures: list[str] = []


def check(label: str, passed: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if passed else 'FAIL'}] {label}{(' -- ' + detail) if detail else ''}")
    if not passed:
        failures.append(label)


def build_musicxml(divisions: int, beats: int, beat_type: int, notes: list[tuple[str, int, int]], tempo: int = 120) -> str:
    """Minimal single-part MusicXML. Each note is (step, octave, duration-in-divisions)."""
    note_xml = []
    for index, (step, octave, duration) in enumerate(notes):
        note_xml.append(
            f"""      <note>
        <pitch><step>{step}</step><octave>{octave}</octave></pitch>
        <duration>{duration}</duration>
        <voice>1</voice>
      </note>"""
        )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>{divisions}</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>{beats}</beats><beat-type>{beat_type}</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>{tempo}</per-minute></metronome></direction-type>
        <sound tempo="{tempo}"/>
      </direction>
{chr(10).join(note_xml)}
    </measure>
  </part>
</score-partwise>
"""


def synthesize(frequencies: list[float], note_seconds: float, sample_rate: int, lead_in_seconds: float = 0.3) -> np.ndarray:
    """Simple sine sequence with short attack/release ramps, mirroring generateSynthetic.ts."""
    chunks = [np.zeros(int(lead_in_seconds * sample_rate), dtype=np.float32)]
    ramp_len = max(1, int(0.01 * sample_rate))
    for frequency in frequencies:
        count = int(note_seconds * sample_rate)
        t = np.arange(count) / sample_rate
        tone = (0.35 * np.sin(2 * np.pi * frequency * t)).astype(np.float32)
        envelope = np.ones(count, dtype=np.float32)
        envelope[:ramp_len] = np.linspace(0, 1, ramp_len)
        envelope[-ramp_len:] = np.linspace(1, 0, ramp_len)
        chunks.append(tone * envelope)
    chunks.append(np.zeros(int(0.3 * sample_rate), dtype=np.float32))
    return np.concatenate(chunks)


def read_wav_mono(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path)) as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, sample_rate


def tracking_error(aligner: LiveAligner, truth_quarter_at: "callable", every_s: float = 1.0) -> tuple[float, float]:
    """Mean signed and mean absolute error (quarter notes) of the finished run vs. a truth function.

    Reads the follower's own alignment path -- (beat, audio-seconds) per processed frame -- rather
    than sampling positions at push time. Sampling at push time silently measures the follower's
    processing backlog when chunks are pushed faster than real time, which once produced a
    convincing-looking (and entirely fictitious) 25% tracking lag here.
    """
    beats, times = aligner.matchmaker.score_follower.alignment_path
    quarters = [aligner.score_part.quarter_map(aligner.score_part.inv_beat_map(b)) for b in beats]
    errors = []
    t = every_s
    while t < times[-1]:
        i = int(np.searchsorted(times, t))
        if i < len(quarters):
            errors.append(float(quarters[i]) - truth_quarter_at(t))
        t += every_s
    return float(np.mean(errors)), float(np.mean(np.abs(errors)))


def feed(aligner: LiveAligner, samples: np.ndarray) -> list[tuple[float, float]]:
    """Push the whole clip through the aligner and collect reported positions."""
    import threading
    import traceback

    positions: list[tuple[float, float]] = []
    errors: list[str] = []

    def run() -> None:
        # Re-raised as a check failure rather than dying silently on the worker thread: an
        # exception in here otherwise looks identical to "alignment reported nothing", which sends
        # you hunting in the wrong place.
        try:
            aligner.run(lambda quarter, beat: positions.append((quarter, beat)))
        except Exception:  # noqa: BLE001
            errors.append(traceback.format_exc())

    worker = threading.Thread(target=run, daemon=True)
    worker.start()

    hop = aligner.hop_length
    for start in range(0, len(samples) - hop + 1, hop):
        aligner.push_chunk(samples[start : start + hop].astype(np.float32).tobytes())
    aligner.push_sentinel()
    worker.join(timeout=120)

    if errors:
        check("alignment thread ran without raising", False, errors[0].strip().splitlines()[-1])
        print(errors[0])
    return positions


# --------------------------------------------------------------------------------------------
# 1. Beat -> quarter conversion. No audio needed. This is the bug class that bit the previous
#    attempt: Matchmaker reports beats in the time signature's own denominator, so 6/8 and 2/2
#    disagree with quarter notes in opposite directions, and 4/4 hides the bug entirely.
# --------------------------------------------------------------------------------------------
def check_beat_conversion() -> None:
    print("\n[1] beat -> quarter conversion")
    import partitura

    cases = [
        # (label, xml, [(beat, expected_quarter)])
        (
            "4/4 (beat == quarter)",
            build_musicxml(4, 4, 4, [("C", 4, 4), ("D", 4, 4), ("E", 4, 4), ("F", 4, 4)]),
            [(0.0, 0.0), (1.0, 1.0), (3.0, 3.0)],
        ),
        (
            "6/8 (beat == eighth, so 1 beat == 0.5 quarters)",
            build_musicxml(4, 6, 8, [("C", 4, 2)] * 6),
            [(0.0, 0.0), (2.0, 1.0), (4.0, 2.0)],
        ),
        (
            "2/2 (beat == half, so 1 beat == 2 quarters)",
            build_musicxml(4, 2, 2, [("C", 4, 8), ("D", 4, 8)]),
            [(0.0, 0.0), (1.0, 2.0)],
        ),
    ]

    for label, xml, expectations in cases:
        _, path = write_score(xml)
        part = partitura.load_musicxml(str(path), ignore_invisible_objects=True)
        part = partitura.score.merge_parts(part.parts)
        actual = [convert_beat_to_quarter(part, beat) for beat, _ in expectations]
        expected = [value for _, value in expectations]
        ok = all(abs(a - e) < 1e-6 for a, e in zip(actual, expected))
        check(label, ok, f"beats {[b for b, _ in expectations]} -> {actual}, expected {expected}")

    # Monotonicity over a denser sweep -- a conversion that's right at sampled points but
    # non-monotone between them would still walk the cursor backwards mid-note.
    _, path = write_score(build_musicxml(4, 6, 8, [("C", 4, 2)] * 6))
    part = partitura.score.merge_parts(partitura.load_musicxml(str(path), ignore_invisible_objects=True).parts)
    sweep = [convert_beat_to_quarter(part, b / 10.0) for b in range(0, 60)]
    check("monotone across a 6/8 sweep", all(b >= a - 1e-9 for a, b in zip(sweep, sweep[1:])))


# --------------------------------------------------------------------------------------------
# 2. Alignment progresses on a synthetic melody that matches its own score.
# --------------------------------------------------------------------------------------------
def check_alignment_progress() -> None:
    print("\n[2] alignment progress on a synthetic melody")
    sample_rate = 48000
    tempo = 120  # quarter = 500ms
    scale = [("G", 4, 4), ("A", 4, 4), ("B", 4, 4), ("C", 5, 4), ("D", 5, 4), ("E", 5, 4), ("F", 5, 4), ("G", 5, 4)]
    frequencies = [392.0, 440.0, 493.88, 523.25, 587.33, 659.25, 698.46, 783.99]
    xml = build_musicxml(4, 4, 4, scale, tempo=tempo)
    digest, path = write_score(xml)

    audio = synthesize(frequencies, note_seconds=60.0 / tempo, sample_rate=sample_rate)
    aligner = LiveAligner(path, digest, sample_rate)

    started = time.time()
    positions = feed(aligner, audio)
    elapsed = time.time() - started
    audio_seconds = len(audio) / sample_rate

    check("produced position updates", len(positions) > 0, f"{len(positions)} updates")
    if not positions:
        return

    quarters = [q for q, _ in positions]
    check("starts near the beginning", quarters[0] < 2.0, f"first quarter {quarters[0]:.2f}")
    check(
        "advances through most of the piece",
        quarters[-1] >= aligner.total_quarters * 0.7,
        f"final {quarters[-1]:.2f} of {aligner.total_quarters:.2f}",
    )
    backward = sum(1 for a, b in zip(quarters, quarters[1:]) if b < a - 0.01)
    check("mostly forward motion", backward <= len(quarters) * 0.1, f"{backward} backward steps of {len(quarters)}")
    check(
        "faster than real time",
        elapsed < audio_seconds,
        f"{elapsed:.2f}s to process {audio_seconds:.2f}s (RTF {elapsed / audio_seconds:.2f})",
    )
    lead = 0.3  # synthesize() lead-in
    spq = 60.0 / tempo
    _, mean_abs = tracking_error(aligner, lambda t: min(8.0, max(0.0, (t - lead) / spq)))
    check("tracks within half a beat on average", mean_abs < 0.5, f"mean |error| {mean_abs:.2f} qn")

    # The library's follower, fed silence or noise, has nothing to anchor to and creeps forward
    # at about the reference tempo, then sprints once real playing starts (it cannot move
    # backwards) -- the first live session swept a whole piece in seconds this way. The gated
    # follower in matchmaker_service.py (_GatedArztFollower) ignores non-tonal frames outright,
    # so the position must hold through both. The wrong note is deliberately NOT in this list: it
    # is tonal, so it passes the gate and the alignment treats it as playing -- that's a known,
    # accepted limit, not a regression.
    silence = np.random.randn(int(5.0 * sample_rate)).astype(np.float32) * 0.002
    noise = np.random.randn(int(5.0 * sample_rate)).astype(np.float32) * 0.1
    for label, junk in (("silence", silence), ("loud noise", noise)):
        aligner = LiveAligner(path, digest, sample_rate)
        feed(aligner, np.concatenate([junk, audio]))
        beats, times = aligner.matchmaker.score_follower.alignment_path
        at_5s = float(beats[min(len(beats) - 1, int(np.searchsorted(times, 5.0)))])
        accepted, rejected = aligner.frame_stats()
        check(f"holds at the start through 5s of leading {label}", at_5s < 0.5, f"position {at_5s:.2f} qn; rejected {rejected} frames")
        check(f"still reaches the end after the {label}", float(beats[-1]) >= 6.0, f"final {float(beats[-1]):.2f} of 8")


# --------------------------------------------------------------------------------------------
# 3. Real recorded violin, stitched into a four-note phrase.
#
#    Each fixture in dataset/ is one sustained note, and a single-note score is structurally
#    unalignable: matchmaker.utils.misc.generate_score_audio truncates its reference at the LAST
#    ONSET plus 0.1s, so a one-note score produces ~2 reference frames. (Worth knowing generally:
#    the final note of any score contributes only its attack to the reference -- there is no score
#    position left to distinguish after it, by design.) Concatenating the four open strings gives
#    real violin timbre AND real positional structure to track through.
# --------------------------------------------------------------------------------------------
OPEN_STRINGS = [
    ("open-g3.wav", "G", 3, 1.22, 4.75),
    ("open-d4.wav", "D", 4, 1.52, 5.82),
    ("open-a4.wav", "A", 4, 1.56, 7.90),
    ("open-e5.wav", "E", 5, 1.23, 4.71),
]
NOTE_SECONDS = 1.5


def check_real_violin() -> None:
    print("\n[3] real recorded violin (four open strings stitched into a phrase)")
    missing = [name for name, *_ in OPEN_STRINGS if not (DATASET_DIR / name).exists()]
    if missing:
        check("fixtures present", False, f"missing {missing} (dataset/ is gitignored)")
        return

    performance: list[np.ndarray] = []
    sample_rate = 0
    for name, _step, _octave, steady_start, steady_end in OPEN_STRINGS:
        samples, sample_rate = read_wav_mono(DATASET_DIR / name)
        # Trim to the steady portion (per ground-truth.json) so each note occupies its own slot
        # instead of dragging the clip's leading silence into the phrase.
        start = int(steady_start * sample_rate)
        end = min(int(steady_end * sample_rate), start + int(NOTE_SECONDS * sample_rate))
        performance.append(samples[start:end])
    audio = np.concatenate(performance)

    # Quarter notes at 40bpm are 1.5s each, matching the slices above.
    tempo = round(60.0 / NOTE_SECONDS)
    notes = [(step, octave, 4) for _name, step, octave, _s, _e in OPEN_STRINGS]
    digest, path = write_score(build_musicxml(4, 4, 4, notes, tempo=tempo))
    aligner = LiveAligner(path, digest, sample_rate)
    positions = feed(aligner, audio)

    check("produced position updates", len(positions) > 0, f"{len(positions)} updates")
    if not positions:
        return

    quarters = [q for q, _ in positions]
    check("starts near the beginning", quarters[0] < 1.5, f"first quarter {quarters[0]:.2f}")
    check("reaches the final note", max(quarters) >= 3.0, f"max quarter {max(quarters):.2f}")
    check(
        "stays inside the score",
        max(quarters) <= aligner.total_quarters + 0.5,
        f"max {max(quarters):.2f} vs total {aligner.total_quarters:.2f}",
    )
    backward = sum(1 for a, b in zip(quarters, quarters[1:]) if b < a - 0.01)
    check("mostly forward motion", backward <= len(quarters) * 0.15, f"{backward} backward of {len(quarters)}")


# --------------------------------------------------------------------------------------------
# 4. Reference-feature cache actually saves the expensive work.
# --------------------------------------------------------------------------------------------
def check_reference_cache() -> None:
    print("\n[4] reference feature cache")
    xml = build_musicxml(4, 4, 4, [("C", 4, 4), ("E", 4, 4), ("G", 4, 4), ("C", 5, 4)], tempo=100)
    digest, path = write_score(xml)

    cold_started = time.time()
    LiveAligner(path, digest, 48000)
    cold = time.time() - cold_started

    warm_started = time.time()
    LiveAligner(path, digest, 48000)
    warm = time.time() - warm_started

    check("warm construction is faster", warm < cold, f"cold {cold:.2f}s, warm {warm:.2f}s")
    print(f"       (cold-start synthesis cost on this machine: {cold:.2f}s)")


# --------------------------------------------------------------------------------------------
# 5. Post-practice offline alignment (LiveAligner.compute_offline_alignment) -- the global pass
#    whose output the browser uses to grade intonation after a take.
#
#    The score repeats its first phrase at the end (A B A), deliberately: that's what rules out
#    both plain full-length DTW (which would stretch a partial take across the whole piece) and
#    subsequence DTW (which could land a take of the first A on the last one).
# --------------------------------------------------------------------------------------------
# Twinkle's opening in G: consecutive repeated pitches carry no chroma change at the boundary,
# which is where the causal live tracker was measured losing the most time on a slower take.
PHRASE_A = [("G", 4, 392.00), ("G", 4, 392.00), ("D", 5, 587.33), ("D", 5, 587.33), ("E", 5, 659.25), ("E", 5, 659.25), ("D", 5, 587.33)]
PHRASE_B = [("E", 5, 659.25), ("D", 5, 587.33), ("F", 5, 698.46), ("E", 5, 659.25)]
REPEATING_SCORE = PHRASE_A + PHRASE_B + PHRASE_A


def _offline_session(tempo_bpm: float, notes_played: int, noise_burst: tuple[float, float] | None = None):
    """Play the first `notes_played` notes of REPEATING_SCORE at `tempo_bpm` against a 120bpm score."""
    sample_rate = 48000
    xml = build_musicxml(4, 4, 4, [(step, octave, 4) for step, octave, _ in REPEATING_SCORE], tempo=120)
    digest, path = write_score(xml)
    seconds_per_quarter = 60.0 / tempo_bpm
    lead = 0.3
    audio = synthesize([hz for _, _, hz in REPEATING_SCORE[:notes_played]], seconds_per_quarter, sample_rate, lead_in_seconds=lead)
    if noise_burst is not None:
        start, end = (int(t * sample_rate) for t in noise_burst)
        audio[start:end] += (np.random.randn(end - start) * 0.1).astype(np.float32)

    aligner = LiveAligner(path, digest, sample_rate)
    feed(aligner, audio)

    started = time.time()
    points = aligner.compute_offline_alignment()
    elapsed = time.time() - started

    def onset_errors(times: np.ndarray, quarters: np.ndarray) -> np.ndarray:
        # When the path first reaches each played onset, vs. when that note actually started.
        quarters = np.maximum.accumulate(quarters)
        errors = []
        for onset in range(1, notes_played):
            i = int(np.searchsorted(quarters, onset - 1e-6))
            if i < len(times):
                errors.append(abs(times[i] - (lead + onset * seconds_per_quarter)))
        return np.array(errors)

    offline_times = np.array([t for t, _ in points])
    offline_quarters = np.array([q for _, q in points])
    beats, live_times = aligner.matchmaker.score_follower.alignment_path
    live_quarters = np.array([aligner.score_part.quarter_map(aligner.score_part.inv_beat_map(b)) for b in beats])
    # The library labels each live frame by the START of its analysis window; the offline path is
    # labelled by the window's CENTRE (the convention the browser's pitch frames use, so it's the
    # right one for mapping). Put live on the same convention before comparing -- otherwise the
    # two differ by a constant half-window and the comparison measures labelling, not tracking.
    live_times_centred = np.asarray(live_times) + (aligner.matchmaker.processor.n_fft / 2) / sample_rate
    return {
        "points": points,
        "elapsed": elapsed,
        "offline": onset_errors(offline_times, offline_quarters) if points else np.array([np.inf]),
        "live": onset_errors(live_times_centred, live_quarters),
        "final_quarter": float(offline_quarters[-1]) if points else float("nan"),
    }


def check_offline_alignment() -> None:
    print("\n[5] post-practice offline alignment")

    # One analysis frame at 30fps is 33ms, so that's the resolution floor for either tracker.
    full = _offline_session(120, len(REPEATING_SCORE))
    check("produces a path", len(full["points"]) > 0, f"{len(full['points'])} points")
    check(
        "full take: note onsets placed within ~1 frame",
        float(np.percentile(full["offline"], 95)) <= 0.05,
        f"offline p95 {np.percentile(full['offline'], 95) * 1000:.0f}ms (live {np.percentile(full['live'], 95) * 1000:.0f}ms)",
    )
    check("offline pass is fast", full["elapsed"] < 5.0, f"{full['elapsed']:.2f}s")

    # The case the offline pass exists for: the player isn't at the reference tempo.
    slow = _offline_session(90, len(REPEATING_SCORE))
    check(
        "slower take: offline no worse than live",
        float(np.percentile(slow["offline"], 95)) <= float(np.percentile(slow["live"], 95)) + 1e-6,
        f"offline p95 {np.percentile(slow['offline'], 95) * 1000:.0f}ms vs live {np.percentile(slow['live'], 95) * 1000:.0f}ms",
    )
    check(
        "slower take: note onsets placed within ~1 frame",
        float(np.percentile(slow["offline"], 95)) <= 0.05,
        f"offline p95 {np.percentile(slow['offline'], 95) * 1000:.0f}ms",
    )

    # Stopped after the first phrase: must end there, not stretch over the piece, and not jump to
    # the identical final phrase.
    partial = _offline_session(120, len(PHRASE_A))
    check(
        "partial take ends where the player stopped",
        len(PHRASE_A) - 1 <= partial["final_quarter"] <= len(PHRASE_A) + 0.5,
        f"final quarter {partial['final_quarter']:.2f} (played {len(PHRASE_A)} notes; score is {len(REPEATING_SCORE)})",
    )

    # Loud noise mid-take doesn't move the note boundaries.
    noisy = _offline_session(120, len(REPEATING_SCORE), noise_burst=(2.4, 2.9))
    check(
        "noise burst inside the take doesn't shift note placement",
        float(np.percentile(noisy["offline"], 95)) <= 0.05,
        f"offline p95 {np.percentile(noisy['offline'], 95) * 1000:.0f}ms",
    )


def main() -> int:
    print(f"Matchmaker offline check (frame rate {FRAME_RATE})")
    check_beat_conversion()
    check_alignment_progress()
    check_real_violin()
    check_reference_cache()
    check_offline_alignment()

    print("\n" + ("All checks passed." if not failures else f"{len(failures)} check(s) failed:"))
    for failure in failures:
        print(f"  - {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
