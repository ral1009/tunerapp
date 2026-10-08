"""Real-time score-following via the Matchmaker library.

Deliberately free of FastAPI imports so it can be exercised standalone by
``server/offline_check.py`` without starting a web server -- same "offline first" convention as the
Node side's ``npm run phase0:validate`` / ``npm run followerTest``.

Browser PCM reaches Matchmaker through ``BytesAudioStream``, the library's own supported path for
feeding audio from somewhere other than a local microphone device (``Matchmaker.__init__`` takes a
``stream=`` instance and uses it verbatim). An earlier integration against 0.1.1rc1 predated that
support and had to construct a real ``AudioStream`` and then swap it out post-construction; nothing
like that is needed here.
"""

from __future__ import annotations

import hashlib
import os
import logging
import queue
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Callable

import numpy as np
from matchmaker import Matchmaker
from matchmaker.dp import OnlineTimeWarpingArztFrame
from matchmaker.matchmaker import DEFAULT_KWARGS, get_ppq
from matchmaker.io.audio import BytesAudioStream, set_latency_stats
from matchmaker.io.stream import STREAM_END
from partitura.score import Part

logger = logging.getLogger("matchmaker_service")

BASE_DIR = Path(__file__).resolve().parent
SCORE_CACHE_DIR = BASE_DIR / "tmp" / "scores"

# Matchmaker's own frame rate for audio features. The library defaults to this and
# Matchmaker._convert_frame_to_beat() assumes it when turning a follower frame index back into a
# beat, so the reference side must stay here. The live side derives its hop from whatever sample
# rate the browser reports, which keeps both sides at the same frames-per-second.
FRAME_RATE = 30

# Arzt's backward-forward OLTW, per the Matchmaker paper (arXiv:2510.10087): comparable mean error
# to Dixon but materially higher total alignment rate, because it can correct an early
# misalignment instead of being stuck with it. HMM methods trail both badly there.
ALIGNMENT_METHOD = "arzt"

# Chroma rather than the paper's better-performing log-spectral-energy. LSE wins on the paper's
# solo-piano benchmark, but direct testing on monophonic material (a synthetic melody and this
# repo's own recorded violin fixture) had it stuck at beat 0 in both cases -- plausibly because an
# onset-energy feature with no pitch content has far less to discriminate on when there's only one
# sparse melodic line. Don't switch without violin-specific evidence.
FEATURE_PROCESSOR = "chroma"

# A live chroma frame that isn't tonal -- no pitch class stands out -- is ignored: the alignment
# state freezes until a note arrives. The library's follower has no such check; it maps every
# frame to somewhere in the score and only ever moves forward, so noise or silence walks the
# position forward at roughly the reference tempo. "Tonal" is judged by the chroma vector's
# flatness: max-normalized, a single clear pitch class gives a mean near 1/12, while broadband
# noise or silence gives a mean near 1. Measured on this repo's real recorded violin fixtures
# (all four open strings and four fingered notes): flatness 0.00-0.31. White noise, pink noise
# and near-silence: 0.84-0.91. A speech-like jittered harmonic signal: 0.62. 0.5 clears every
# note with margin and rejects everything else.
#
# Deliberately NOT "does this frame match the score" (best-match cost against the reference):
# that was tried first and rejected a third of real violin frames, because the reference is a
# piano soundfont and a violin's harmonic balance differs enough that a real open E string
# scored worse against its own note than a wrong note did. The alignment itself tolerates that
# timbre gap fine; a gate stricter than the alignment is the wrong tool. Flatness asks only
# "is this a note", which is the question that actually separates playing from noise.
REJECT_CHROMA_FLATNESS = 0.5

# How far either side of the live tracker's final position the offline alignment looks for where
# the take actually ended -- see LiveAligner.compute_offline_alignment.
OFFLINE_END_SEARCH_SECONDS = 2
# An end within this many frames (0.2 s) of the reference's last frame is treated as the last frame.
OFFLINE_END_SNAP_FRAMES = 6

# Reference features are a pure function of (score, tempo, sample rate), and recomputing them means
# re-running fluidsynth synthesis plus chroma extraction on every session -- wasted work when the
# same piece is practiced repeatedly. Bounded because a long session across many pieces shouldn't
# grow this without limit; entries are small, so this is about bounding growth, not real pressure.
_REFERENCE_CACHE_MAX_ENTRIES = 20
_reference_cache: "OrderedDict[str, np.ndarray]" = OrderedDict()
_reference_cache_lock = threading.Lock()


def score_hash(xml: str) -> str:
    return hashlib.sha256(xml.encode("utf-8")).hexdigest()


def write_score(xml: str) -> tuple[str, Path]:
    """Persist MusicXML to a hash-named file, since Matchmaker loads scores by path."""
    digest = score_hash(xml)
    SCORE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = SCORE_CACHE_DIR / f"{digest}.musicxml"
    if not path.exists():
        path.write_text(xml, encoding="utf-8")
    return digest, path


def has_cached_score(digest: str) -> Path | None:
    path = SCORE_CACHE_DIR / f"{digest}.musicxml"
    return path if path.exists() else None


def convert_beat_to_quarter(score_part: Part, beat: float) -> float:
    """Convert a Matchmaker beat position to quarter notes.

    Matchmaker reports positions in partitura's ``beat_map`` units, which are one note of the
    active time signature's denominator -- an eighth in 6/8, a half in 2/2, a quarter only in x/4.
    Everything on the TypeScript side (ScoreNote.durationBeats, CursorNoteInfo.durationQuarterNotes,
    the metronome's tick accounting) is in quarter notes, so this has to be converted before it
    leaves the server. Routing through partitura's own inverse map avoids re-deriving meter
    handling by hand, which is exactly where a previous attempt went wrong.
    """
    timeline_time = score_part.inv_beat_map(beat)
    return float(score_part.quarter_map(timeline_time))


def is_tonal_frame(chroma_frame: np.ndarray) -> bool:
    """True when one pitch class stands out in a chroma frame -- see REJECT_CHROMA_FLATNESS."""
    chroma = np.asarray(chroma_frame, dtype=np.float32).reshape(-1)
    peak = float(chroma.max()) if chroma.size else 0.0
    # Digital silence normalizes to an all-zero vector, whose mean is 0 -- maximally "peaked" by
    # the flatness measure, so it needs its own check.
    return peak > 0.0 and float(chroma.mean()) / peak <= REJECT_CHROMA_FLATNESS


# The tonality test above lets anything with a clear pitch through, and so did talking (voiced
# speech is tonal: flatness 0.15-0.45 on three TTS voices, inside the violin's 0.12-0.29) and the
# ring of the open strings after the violin is bumped. Both walked the cursor forward and left the
# notes they passed graded "unclear" (live report, 2026-10-08). PlayingGate adds three checks, set
# on TTS speech and synthetic bumps (.scratch/gate_sim.py) and checked against real violin -- the
# dev recordings and the user's two takes -- for how much playing they'd throw away:
# - Energy below the violin's range (60-180 Hz; open G is 196 Hz): voiced male speech has its
#   fundamental there, violin has nothing there at all (ratio 0.00 at the 95th percentile).
# - To START accepting after a break, PLAYING_GATE_OPEN_FRAMES (~130 ms) of steady pitch class
#   (consecutive chroma cosine >= PLAYING_GATE_STABILITY) whose level isn't falling: a bowed note
#   holds its pitch and level, speech glides between syllables, and a bump's ring decays from the
#   knock. Once open, the frames that led up to it are released too, so no note start is lost.
# - Once open, any tonal frame keeps it open, and within PLAYING_GATE_RESUME_FRAMES (100 ms) of
#   closing any tonal frame reopens it: a single non-tonal frame mid-passage (a string crossing, a
#   scratchy bow change) shouldn't make fast playing re-earn the steady-pitch test -- without this
#   it cost 1.5 s of a fast Corrente passage. Kept short because speech reuses it between
#   syllables (0.5 s let a flat TTS voice through 65% of the time; 100 ms, 47%). A "must keep
#   finding steady stretches to stay open" rule was also tried and never fired on anything the
#   opening test hadn't already stopped.
# Measured: violin frames kept 99.8% (fast Bach) and 98.8-99.6% (user takes); male TTS 0%, two
# female TTS voices 11% and 47% (the 47% is a flat-prosody voice; real speech moves pitch more);
# synthetic bumps 0%. Accepted speech frames still move the cursor, so this is fewer false
# advances, not none.
PLAYING_GATE_OPEN_FRAMES = 4
PLAYING_GATE_STABILITY = 0.9
PLAYING_GATE_OPEN_LEVEL_RATIO = 0.9
PLAYING_GATE_RESUME_FRAMES = 3
PLAYING_GATE_LOW_BAND_MAX = 0.05
PLAYING_GATE_BACKFILL_FRAMES = 15


def frame_band_stats(power: np.ndarray, sample_rate: int, n_fft: int) -> tuple[np.ndarray, np.ndarray]:
    """(low-band ratio, rms) per frame from an STFT power array shaped (frames, bins)."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    low = power[:, (freqs > 60) & (freqs < 180)].sum(axis=1)
    band = power[:, (freqs >= 180) & (freqs < 4000)].sum(axis=1) + 1e-12
    rms = np.sqrt(power.sum(axis=1) / n_fft)
    return low / band, rms


class PlayingGate:
    """Decides, frame by frame, whether the input is the violin being played -- see above.

    ``push`` takes one frame (an opaque item plus its chroma vector, low-band ratio and rms) and
    returns the items to pass on now: usually [] or [item], and on opening, the run of frames that
    led up to it. Used by both the live stream and the post-take alignment so both see the same
    frames.
    """

    def __init__(self) -> None:
        self.open = False
        self.accepted = 0
        self.rejected = 0
        self._recent: list[tuple[bool, np.ndarray, float]] = []  # (tonal, unit chroma, rms)
        self._pending: list[object] = []  # tonal frames seen while closed, newest last
        self._since_closed = PLAYING_GATE_RESUME_FRAMES + 1

    def _stable(self, k: int) -> bool:
        if len(self._recent) < k:
            return False
        window = self._recent[-k:]
        if not all(tonal for tonal, _, _ in window):
            return False
        return all(float(a[1] @ b[1]) >= PLAYING_GATE_STABILITY for a, b in zip(window, window[1:]))

    def push(self, item: object, chroma_frame: np.ndarray, low_ratio: float, rms: float) -> list:
        chroma = np.asarray(chroma_frame, dtype=np.float32).reshape(-1)
        tonal = is_tonal_frame(chroma) and low_ratio <= PLAYING_GATE_LOW_BAND_MAX
        unit = chroma / (float(np.linalg.norm(chroma)) + 1e-9)
        self._recent.append((tonal, unit, float(rms)))
        del self._recent[:-PLAYING_GATE_OPEN_FRAMES]

        if not self.open:
            if not tonal:
                self._since_closed += 1
                self.rejected += len(self._pending) + 1
                self._pending.clear()
                return []
            self._pending.append(item)
            if len(self._pending) > PLAYING_GATE_BACKFILL_FRAMES:
                self._pending.pop(0)
                self.rejected += 1
            levels = [r for _, _, r in self._recent]
            resuming = self._since_closed <= PLAYING_GATE_RESUME_FRAMES
            self._since_closed += 1
            if resuming or (
                self._stable(PLAYING_GATE_OPEN_FRAMES) and levels[-1] >= PLAYING_GATE_OPEN_LEVEL_RATIO * max(levels)
            ):
                self.open = True
                released, self._pending = self._pending, []
                self.accepted += len(released)
                return released
            return []

        if not tonal:
            self.open = False
            self._since_closed = 1
            self.rejected += 1
            return []
        self.accepted += 1
        return [item]


_soundfont_keeper: list = []  # see warm_up()


def _install_dynamic_sample_loading() -> None:
    """Make partitura's fluidsynth renderer load only the instrument samples a score uses.

    partitura builds a fresh ``Synth`` and ``sfload``s its bundled MuseScore_General.sf3 on every
    render. That file is 40 MB of Ogg-compressed samples, and a full load decompresses every
    instrument: 13-17 s per session on the dev machine, the bulk of "preparing the score" (30 s
    for a 900-note piece), paid again even for a score already seen. FluidSynth's
    ``synth.dynamic-sample-loading`` defers each sample until a preset using it is selected (here,
    only the piano). Reference audio verified bit-identical on a 900-note score.

    Each render still gets its own fresh synth. Reusing one synth across renders was tried and is
    NOT output-neutral: state survives ``system_reset()`` and changed every sample of the next
    render. Patched rather than forked because partitura exposes no hook for synth settings; it
    looks ``Synth`` up as a module global at call time.
    """
    try:
        import fluidsynth
        import partitura.utils.fluidsynth as pt_fluidsynth
    except ImportError:  # no fluidsynth: partitura reports that itself when asked to render
        return

    class _DynamicLoadingSynth(fluidsynth.Synth):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("synth.dynamic-sample-loading", 1)
            super().__init__(*args, **kwargs)

    pt_fluidsynth.Synth = _DynamicLoadingSynth


_install_dynamic_sample_loading()


def warm_up() -> None:
    """Pay the once-per-process costs before the first session instead of during it.

    Measured cold on the dev machine: ~8 s to decompress the piano samples, ~5-11 s for librosa's
    lazily-imported feature module. FluidSynth caches decompressed samples process-wide for as long
    as any synth holds the soundfont, so one idle "keeper" synth that has loaded the piano makes
    every later render's fresh synth load in ~0.1 s. Called from the server's startup on a
    background thread; safe to skip (the first session just pays these itself).
    """
    started = time.time()
    try:
        import librosa
        import partitura.utils.fluidsynth as pt_fluidsynth

        librosa.feature.chroma_stft  # noqa: B018 -- forces lazy_loader's import
        if not _soundfont_keeper:
            keeper = pt_fluidsynth.Synth(samplerate=44100)
            sf_id = keeper.sfload(pt_fluidsynth.DEFAULT_SOUNDFONT)
            keeper.program_select(0, sf_id, 0, 0)
            _soundfont_keeper.append(keeper)
        logger.info("Alignment warm-up done in %.1fs", time.time() - started)
    except Exception:  # noqa: BLE001
        logger.exception("Alignment warm-up failed; the first session will be slower")


def _backtrack_from(steps: np.ndarray, end: int) -> list[tuple[int, int]]:
    """Optimal DTW path from (0, 0) to (end, last column), read off librosa's step matrix.

    librosa's own dtw_backtracking only accepts a start row in subsequence mode. This follows the
    same default step set (sigma = [[1, 1], [0, 1], [1, 0]]) that librosa.sequence.dtw used to
    fill ``steps``, so the path is the one a full second dtw() call on reference[:end + 1] returns.
    """
    sigma = ((1, 1), (0, 1), (1, 0))
    i, j = end, steps.shape[1] - 1
    path = [(i, j)]
    while i > 0 or j > 0:
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            di, dj = sigma[int(steps[i, j])]
            i, j = i - di, j - dj
        path.append((i, j))
    return path[::-1]


# How the reference audio for a score is made before chroma extraction. "additive" (default):
# a small numpy synthesizer, below. "fluidsynth": the library's own path (partitura renders the
# score with a piano soundfont). Both go through the same chroma processor, so the reference stays
# in the feature space live audio is compared in.
REFERENCE_SYNTH = os.environ.get("REFERENCE_SYNTH", "additive")
_ADDITIVE_HARMONICS = 8
_ADDITIVE_DECAY_SECONDS = 1.0


def additive_score_audio(score_part: Part, tempo: float, sample_rate: int) -> np.ndarray:
    """Reference audio for alignment without a soundfont: each note as decaying harmonics.

    Timing is exactly matchmaker.utils.misc.generate_score_audio's -- the same per-note tempo
    (scaled by the active time signature's beat type), the same leading pad to the first onset,
    and the same cut 0.1 s after the last onset -- so frame i still maps to the beat that
    _build_ref_frame_to_beat expects. What changes is the sound: fluidsynth's sampled piano is
    replaced by 1/h-weighted harmonics with a soft attack and exponential decay. Chroma only
    looks at pitch-class energy, which both produce; this needs no soundfont, renders in a
    fraction of the time, and is a few lines in any language -- unlike fluidsynth, which can't
    ship in a phone app.
    """
    from partitura.utils.music import ensure_notearray, performance_notearray_from_score_notearray

    note_array = ensure_notearray(score_part)
    if np.min(note_array["onset_beat"]) <= 0:
        note_array["onset_beat"] = note_array["onset_beat"] + np.min(note_array["onset_beat"])
    # get_current_note_bpm, vectorized: tempo * beat_type / 4 of the latest time signature at or
    # before each onset (looked up once per note in the library -- seconds on a long score).
    onset_times = np.asarray(score_part.inv_beat_map(note_array["onset_beat"]))
    changes = sorted((ts.start.t, ts.beat_type) for ts in score_part.time_sigs)
    bpm = np.full(len(note_array), float(tempo))
    for start, beat_type in changes:
        bpm[onset_times >= start] = beat_type / 4 * tempo
    performed = performance_notearray_from_score_notearray(
        snote_array=note_array, bpm=np.column_stack([note_array["onset_beat"], bpm])
    )

    onsets = performed["onset_sec"]
    offsets = onsets + performed["duration_sec"]
    audio = np.zeros(int(np.ceil(offsets.max() * sample_rate)) + 1, dtype=np.float64)
    weights = 1.0 / np.arange(1, _ADDITIVE_HARMONICS + 1)
    for pitch, onset, offset in zip(performed["pitch"], onsets, offsets):
        start = int(onset * sample_rate)
        length = max(1, int((offset - onset) * sample_rate))
        t = np.arange(length) / sample_rate
        f0 = 440.0 * 2 ** ((int(pitch) - 69) / 12)
        harmonics = [h for h in range(1, _ADDITIVE_HARMONICS + 1) if h * f0 < sample_rate / 2]
        tone = sum(weights[h - 1] * np.sin(2 * np.pi * h * f0 * t) for h in harmonics)
        envelope = np.minimum(1.0, t / 0.005) * np.exp(-t / _ADDITIVE_DECAY_SECONDS)
        envelope *= np.minimum(1.0, (length - np.arange(length)) / (0.03 * sample_rate))
        audio[start:start + length] += tone * envelope
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio /= peak

    # Same padding and truncation as generate_score_audio.
    first_onset_in_beat = score_part.note_array()["onset_beat"].min()
    first_onset_in_time = (
        score_part.inv_beat_map(first_onset_in_beat)
        / score_part.quarter_duration_map(score_part.inv_beat_map(first_onset_in_beat))
        * (60 / tempo)
    )
    audio = np.pad(audio, (int(first_onset_in_time * sample_rate), 0))
    last_onset_in_div = np.floor(score_part.note_array()["onset_div"].max())
    last_onset_in_time = (
        last_onset_in_div / score_part.quarter_duration_map(score_part.inv_beat_map(last_onset_in_div)) * (60 / tempo)
    )
    return audio[: int((last_onset_in_time + 0.1) * sample_rate)].astype(np.float32)


class _PatientBytesAudioStream(BytesAudioStream):
    """BytesAudioStream that waits indefinitely for the next chunk instead of ending the stream.

    The library's version gives up after ``QUEUE_TIMEOUT`` (10s) with an empty queue -- sensible
    for a file or a device that has stopped, wrong here: the browser deliberately sends nothing
    while the player is silent (see audio/matchmakerStream.ts), so a pause is not the end of the
    performance. Only the ``None`` sentinel ends this stream. Polls with a short timeout so
    ``stop_listening`` (which clears ``listen``) still takes effect.
    """

    gate: PlayingGate

    def _process_feature(self, target_audio: np.ndarray, f_time: float) -> None:
        # The library's version (matchmaker.io.audio) with PlayingGate between the processor and
        # the follower's queue. Same framing: the first block is zero-padded and its frame dropped.
        if not hasattr(self, "gate"):
            self.gate = PlayingGate()
        if self.last_chunk is None:
            target_audio = np.concatenate((np.zeros(self.cache_size, dtype=np.float32), target_audio))
        else:
            target_audio = np.concatenate((self.last_chunk, target_audio))
        perf_time = self._emit_count * self.hop_length / float(self.sample_rate)
        output = self.processor((target_audio, perf_time))
        if self.last_chunk is not None:
            self._emit_count += 1
            n_fft = self.processor.n_fft
            frame = target_audio[-n_fft:] * np.hanning(n_fft + 1)[:-1].astype(np.float32)
            power = (np.abs(np.fft.rfft(frame)) ** 2)[None, :]
            low, rms = frame_band_stats(power, self.sample_rate, n_fft)
            for released in self.gate.push(output, output[0][-1], float(low[0]), float(rms[0])):
                self.queue.put(released)
        latency = time.time() - self.last_data_received
        self.latency_stats = set_latency_stats(latency, self.latency_stats, self.input_index)
        self.last_chunk = target_audio[-self.cache_size:]

    def run(self) -> None:
        self.start_listening()
        while self.listen:
            try:
                data = self.data_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if data is None:
                self.queue.put(STREAM_END)
                return
            audio_chunk = np.frombuffer(data, dtype=np.float32)
            self.last_data_received = time.time()
            self._process_feature(audio_chunk, self.last_data_received)
            if not self.stream_start.is_set():
                self.stream_start.set()
        self.queue.put(STREAM_END)


class _GatedArztFollower(OnlineTimeWarpingArztFrame):
    """Arzt OLTW that ignores input frames with no tonal content.

    See REJECT_CHROMA_FLATNESS. A rejected frame touches nothing -- no cost-matrix update, no
    input index advance -- so a stretch of noise or silence of any length leaves the position
    exactly where the last real note put it.
    """

    rejected_frames: int = 0
    accepted_frames: int = 0
    # Set from the socket thread by LiveAligner.seek(); applied here, on the follower's own thread,
    # before the next frame (an int assignment is atomic, so no lock).
    pending_seek: int | None = None

    def _apply_seek(self, frame: int) -> None:
        # Restart the path at `frame`: every accumulated cost is discarded and the only finite
        # cell is the target in the "previous input" column, so the next frame's best path must
        # start there. The follower only ever moves forward on its own; this is the one way back.
        self.global_cost_matrix[:] = np.inf
        self.global_cost_matrix[frame + 1, 0] = 0.0
        self._current_frame = frame
        self.current_index = self._frame_to_score_idx(frame)

    def step(self, input_features: np.ndarray) -> None:
        seek, self.pending_seek = self.pending_seek, None
        if seek is not None:
            self._apply_seek(seek)
        if not is_tonal_frame(input_features):
            self.rejected_frames += 1
            return
        self.accepted_frames += 1
        super().step(input_features)


class _StreamingMatchmaker(Matchmaker):
    """Matchmaker fed from a queue instead of a device, reusing cached reference features.

    Overrides exactly two hooks, leaving every other part of the library's construction (score
    loading, processor setup, follower wiring) untouched:

    - ``_build_stream`` returns a ``BytesAudioStream`` over our queue. Building the stream here
      rather than passing one to ``__init__`` matters: ``BytesAudioStream`` reads ``n_fft`` off the
      processor to size its frame cache, and the processor only exists once ``Matchmaker.__init__``
      has built it. Passing a pre-built stream would mean guessing that value.
    - ``preprocess_score`` serves reference features from the cache when the same score has already
      been synthesized this session.
    """

    def __init__(self, cache_key: str, data_queue: queue.Queue, **kwargs):
        self._cache_key = cache_key
        self._data_queue = data_queue
        super().__init__(**kwargs)

    def _build_stream(self, method, wait):
        return _PatientBytesAudioStream(
            processor=self.processor,
            sample_rate=self.sample_rate,
            hop_length=self.hop_length,
            data_queue=self._data_queue,
        )

    def _build_audio_follower(self, method):
        # Mirrors the library's own construction for "arzt" exactly, substituting the gated
        # subclass. Any other method falls through to the library.
        if method != ALIGNMENT_METHOD:
            return super()._build_audio_follower(method)
        return _GatedArztFollower(
            reference_features=self.reference_features,
            score_positions=np.unique(self.score_part.note_array()["onset_beat"]),
            queue=self.stream.queue,
            frame_rate=self.frame_rate,
            ref_frame_to_beat=self._build_ref_frame_to_beat(),
            **self.config,
        )

    def _build_ref_frame_to_beat(self) -> np.ndarray:
        # Same mapping as the library's version, which calls the score's beat_map once per
        # reference frame (a Python loop over partitura's interpolator -- 5.5 s for a 4,000-frame,
        # two-minute piece, paid on every session even when the features are cached). beat_map is
        # a numpy interpolator, so one call over every frame's timeline position is equivalent.
        n_ref = self.reference_features.shape[0]
        tick = get_ppq(self.score_part)
        timeline = (np.arange(n_ref) / self.frame_rate) * tick * (self.tempo / 60)
        return np.asarray(self.score_part.beat_map(timeline), dtype=float)

    def preprocess_score(self):
        cache_key = f"{self._cache_key}:{REFERENCE_SYNTH}"
        with _reference_cache_lock:
            cached = _reference_cache.get(cache_key)
            if cached is not None:
                _reference_cache.move_to_end(cache_key)
                logger.info("Reference features cache hit for %s", self._cache_key[:12])
                return cached

        if REFERENCE_SYNTH == "additive" and self.input_type == "audio":
            score_audio = additive_score_audio(self.score_part, self.tempo, self.sample_rate)
            features, _ = self.processor((score_audio, 0.0))
            self.processor.reset()
        else:
            features = super().preprocess_score()

        with _reference_cache_lock:
            _reference_cache[cache_key] = features
            while len(_reference_cache) > _REFERENCE_CACHE_MAX_ENTRIES:
                _reference_cache.popitem(last=False)
        return features


class LiveAligner:
    """One score-following session: browser PCM in, quarter-note positions out.

    Construction is the expensive part (fluidsynth renders the score to audio, then chroma features
    are extracted from it), which is why the WebSocket layer only reports "ready" once this
    returns.

    The producer must keep pushing chunks for as long as the session should stay open, including
    while the player is silent: ``BytesAudioStream.run`` ends the stream if its queue stays empty
    for ``matchmaker.io.audio.QUEUE_TIMEOUT`` (10s). Feeding it from a continuously-running
    microphone worklet satisfies that naturally, since chunks arrive whether or not there's sound
    in them.
    """

    def __init__(self, score_path: Path, cache_key: str, sample_rate: int, tempo: float | None = None):
        self.sample_rate = int(sample_rate)
        # Match the reference side's frames-per-second rather than its literal hop, so live and
        # reference chroma frames advance at the same rate even at a different sample rate. Chroma
        # vectors are directly comparable across sample rates -- same 12 pitch classes -- which is
        # what makes it fine for the browser to stay at its device-native rate.
        self.hop_length = max(1, round(self.sample_rate / FRAME_RATE))
        self.data_queue: queue.Queue = queue.Queue()
        self._stopped = threading.Event()
        self._recorded_chunks: list[bytes] = []
        self._recorded_samples = 0
        # (sample offset in the recording, target reference frame, live frame just before the jump)
        self._seeks: list[tuple[int, int, int]] = []

        self.matchmaker = _StreamingMatchmaker(
            cache_key=cache_key,
            data_queue=self.data_queue,
            score_file=str(score_path),
            input_type="audio",
            method=ALIGNMENT_METHOD,
            processor=FEATURE_PROCESSOR,
            tempo=tempo,
            # Merged onto the library's own per-method defaults, as the demo does: passing
            # kwargs= REPLACES DEFAULT_KWARGS entirely rather than extending it, so a bare
            # {sample_rate, hop_length} would silently drop window_size/step_size/
            # start_window_size and leave them to whatever the follower class defaults to.
            kwargs={
                **DEFAULT_KWARGS["audio"][ALIGNMENT_METHOD],
                "sample_rate": self.sample_rate,
                "hop_length": self.hop_length,
            },
        )

        # The follower has its own idle timeout on the feature queue (raises queue.Empty out of
        # the generator after QUEUE_TIMEOUT with nothing to align), same wrong assumption as the
        # stream's -- a silent player is not a finished performance. None blocks until the
        # stream-end marker the sentinel produces.
        self.matchmaker.score_follower.queue_timeout = None

        self.score_part: Part = self.matchmaker.score_part
        self.quarter_origin = float(self.score_part.quarter_map(self.score_part.first_point.t))
        self.total_quarters = float(self.score_part.quarter_map(self.score_part.last_point.t))

    def push_chunk(self, payload: bytes) -> None:
        # Retained for compute_offline_alignment(). Unbounded by design: practice takes are
        # excerpts (tens of seconds to a few minutes, ~11 MB/min at 48 kHz float32), and the
        # buffer lives only as long as this session object.
        self._recorded_chunks.append(payload)
        self._recorded_samples += len(payload) // 4
        self.data_queue.put(payload)

    def quarter_to_ref_frame(self, quarter: float) -> int:
        part = self.score_part
        quarter = min(max(quarter, self.quarter_origin), self.total_quarters)
        beat = float(part.beat_map(part.inv_quarter_map(quarter)))
        ref_frame_to_beat = np.asarray(self.matchmaker.score_follower._ref_frame_to_beat)
        frame = int(np.searchsorted(ref_frame_to_beat, beat - 1e-9, side="left"))
        return min(max(frame, 0), len(ref_frame_to_beat) - 1)

    def seek(self, quarter: float) -> None:
        """Move the live follower to ``quarter`` (the player jumped -- see "Jump to bar" in the app).

        Recorded against the recording's sample count so the post-take alignment can align the
        stretch before and after the jump separately: one DTW path over a take with a jump in it
        would have to smear the jump across the notes around it.
        """
        follower = self.matchmaker.score_follower
        frame = self.quarter_to_ref_frame(quarter)
        live_before = int(getattr(follower, "_current_frame", 0))
        self._seeks.append((self._recorded_samples, frame, live_before))
        follower.pending_seek = frame

    def compute_offline_alignment(self) -> list[tuple[float, float]]:
        """Globally align the whole recorded take against the reference, after the fact.

        Returns ``(perf_time_seconds, quarter)`` pairs sorted by time, where perf time is measured
        on the recording's own timeline (only the audio the browser actually sent -- gated-out
        pauses aren't in it, which is right: we're placing the notes that were played, not
        wall-clock time). Empty when there's too little audio to align.

        Why not just keep the live positions: the live follower is causal and windowed -- it has to
        commit to a position for each frame before hearing what comes next, so its note boundaries
        jitter. Standard DTW sees the entire take at once and backtracks the single cheapest
        monotonic path. ``matchmaker``'s own file mode is no substitute: it replays the same
        causal algorithm from a file (``AudioStream.run_offline``).

        Where the take ENDS is the one thing global DTW can't be trusted to find on its own.
        Pinning the end to the last reference frame assumes the whole piece was played, and
        stretches the score over a partial take. Letting both ends float (subsequence DTW) lets a
        partial take land on a later repeat of the same material -- Twinkle's first and last lines
        are identical. So the live tracker's final position picks a window, and within it the
        end is chosen by lowest normalized cost: the live tracker is reliable about roughly where
        the player stopped, DTW is precise about which frame is which note.
        """
        import librosa  # heavy import, only needed at session end

        if not self._recorded_chunks:
            return []
        audio = np.frombuffer(b"".join(self._recorded_chunks), dtype=np.float32)
        processor = self.matchmaker.processor
        if audio.size < processor.n_fft:
            return []

        # One vectorized call through the SAME processor that built the reference
        # (Matchmaker.preprocess_score does exactly this over the whole synthesized score), so
        # both sides share a feature space by construction.
        features, _ = processor((audio, 0.0))
        # Same PlayingGate as the live stream, so talking or a bump in the take isn't aligned to
        # notes here either.
        power = np.abs(librosa.stft(audio, n_fft=processor.n_fft, hop_length=processor.hop_length, center=False)).T ** 2
        low, rms = frame_band_stats(power[: features.shape[0]], self.sample_rate, processor.n_fft)
        gate = PlayingGate()
        tonal = []
        for i in range(min(features.shape[0], low.shape[0])):
            tonal.extend(gate.push(i, features[i], float(low[i]), float(rms[i])))
        if len(tonal) < 2:
            return []

        follower = self.matchmaker.score_follower
        reference = self.matchmaker.reference_features
        n_ref = reference.shape[0]
        hop = processor.hop_length
        tonal_frames = np.asarray(tonal)

        # One stretch per jump: (first frame, end frame, reference start, live frame at its end).
        live_final = int(min(max(getattr(follower, "_current_frame", n_ref - 1), 0), n_ref - 1))
        stretches = []
        start_frame, ref_start = 0, 0
        for sample, target, live_before in self._seeks:
            stretches.append((start_frame, sample // hop, ref_start, live_before))
            start_frame, ref_start = sample // hop, target
        stretches.append((start_frame, features.shape[0], ref_start, live_final))

        result: list[tuple[float, float]] = []
        for lo, hi, ref_lo, live_end in stretches:
            frames = tonal_frames[(tonal_frames >= lo) & (tonal_frames < hi)] if tonal_frames.size else tonal_frames
            if frames.size < 2 or ref_lo >= n_ref - 1:
                continue
            result.extend(self._align_stretch(features[frames], frames, ref_lo, max(live_end, ref_lo)))
        return result

    def _align_stretch(
        self, perf: np.ndarray, frame_indices: np.ndarray, ref_lo: int, live_end: int
    ) -> list[tuple[float, float]]:
        import librosa

        processor = self.matchmaker.processor
        follower = self.matchmaker.score_follower
        reference = self.matchmaker.reference_features
        n_ref = reference.shape[0]
        live_end = int(min(max(live_end, ref_lo), n_ref - 1))
        window = OFFLINE_END_SEARCH_SECONDS * FRAME_RATE
        end_lo = max(ref_lo + 1, live_end - window)
        end_hi = min(n_ref, live_end + window + 1)

        # Accumulated costs over the widest candidate reference span, then the best end in the
        # window. Normalized by path length so a longer reference isn't penalized just for
        # being longer.
        # One DTW pass: the step matrix of the widest span already contains the optimal path to
        # every candidate end, so backtrack from the chosen one instead of running DTW a second
        # time on the truncated reference (identical path, half the work).
        cost, steps = librosa.sequence.dtw(
            X=reference[ref_lo:end_hi].T, Y=perf.T, metric="cityblock", backtrack=False, return_steps=True
        )
        final_column = cost[:, -1]
        candidates = np.arange(end_lo, end_hi)
        normalized = final_column[candidates - ref_lo] / (candidates - ref_lo + 1 + perf.shape[0])
        end = int(candidates[int(np.argmin(normalized))])
        # The reference stops 0.1 s after the last note starts (see generate_score_audio), so the
        # last note owns only a few reference frames, and an end chosen a frame or two short of the
        # final frame left it with no audio at all ("not played" on the last note of a take that
        # clearly played it). An end that close to the final frame means the take reached the end
        # of the piece: snap to the final frame so the take's tail lands on the last note.
        if end_hi == n_ref and end >= n_ref - 1 - OFFLINE_END_SNAP_FRAMES:
            end = n_ref - 1

        path = _backtrack_from(steps, end - ref_lo)

        ref_frame_to_beat = follower._ref_frame_to_beat
        hop = processor.hop_length
        centre_offset = processor.n_fft / 2
        # DTW paths map several reference frames onto one performance frame (and vice versa);
        # collapse to one point per performance frame at the middle of its reference span.
        spans: dict[int, list[int]] = {}
        for ref_idx, perf_idx in path:
            spans.setdefault(int(perf_idx), []).append(int(ref_idx) + ref_lo)

        perf_frames = sorted(spans)
        ref_frames = [spans[i][len(spans[i]) // 2] for i in perf_frames]
        beats = np.asarray(ref_frame_to_beat)[np.minimum(ref_frames, len(ref_frame_to_beat) - 1)]
        # Vectorized beat -> quarter (same maps as convert_beat_to_quarter); calling it once per
        # point was most of this function's run time (~3 s of 4.8 s on a 2-minute take).
        quarters = np.asarray(self.score_part.quarter_map(self.score_part.inv_beat_map(beats)), dtype=float)
        times = (frame_indices[perf_frames] * hop + centre_offset) / self.sample_rate
        return [(float(t), float(q)) for t, q in zip(times, quarters)]

    def frame_stats(self) -> tuple[int, int]:
        """(accepted, rejected) live frames so far -- see PlayingGate."""
        gate = getattr(self.matchmaker.stream, "gate", None)
        return (gate.accepted, gate.rejected) if gate is not None else (0, 0)

    def push_sentinel(self) -> None:
        """Unblock the worker thread's pending ``queue.get()`` so it can exit.

        Closing the socket alone doesn't end the session: nothing else would ever put another item
        on the queue, so the thread would sit in ``get()`` forever and leak once per session.
        """
        self.data_queue.put(None)

    def stop(self) -> None:
        self._stopped.set()
        self.push_sentinel()
        # Matchmaker.run() blocks on stream_start.wait() until the FIRST audio chunk has been
        # processed. A session stopped before any audio arrived (the user cancels during score
        # preparation) would otherwise leave that thread waiting forever: the sentinel ends the
        # stream's own thread, but nothing ever sets stream_start. Setting it here lets run()
        # proceed to the follower, which immediately sees the stream-end marker and returns.
        # Confirmed as a real leak, one thread per cancelled session, before this line existed.
        stream = self.matchmaker.stream
        if stream is not None:
            stream.stream_start.set()

    def run(self, on_position: Callable[[float, float], None]) -> None:
        """Block on Matchmaker's generator, reporting ``(quarter, beat)`` for each update.

        Runs on a worker thread -- ``Matchmaker.run()`` is a synchronous generator that calls
        ``queue.get()`` internally with no timeout.
        """
        for beat in self.matchmaker.run(verbose=False):
            if self._stopped.is_set():
                break
            try:
                quarter = convert_beat_to_quarter(self.score_part, float(beat))
            except Exception:
                logger.exception("Failed to convert beat %s to quarters", beat)
                continue
            on_position(quarter, float(beat))
