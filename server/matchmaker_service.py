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
from matchmaker.io.audio import BytesAudioStream
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


class _PatientBytesAudioStream(BytesAudioStream):
    """BytesAudioStream that waits indefinitely for the next chunk instead of ending the stream.

    The library's version gives up after ``QUEUE_TIMEOUT`` (10s) with an empty queue -- sensible
    for a file or a device that has stopped, wrong here: the browser deliberately sends nothing
    while the player is silent (see audio/matchmakerStream.ts), so a pause is not the end of the
    performance. Only the ``None`` sentinel ends this stream. Polls with a short timeout so
    ``stop_listening`` (which clears ``listen``) still takes effect.
    """

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

    def step(self, input_features: np.ndarray) -> None:
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
        with _reference_cache_lock:
            cached = _reference_cache.get(self._cache_key)
            if cached is not None:
                _reference_cache.move_to_end(self._cache_key)
                logger.info("Reference features cache hit for %s", self._cache_key[:12])
                return cached

        features = super().preprocess_score()

        with _reference_cache_lock:
            _reference_cache[self._cache_key] = features
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
        self.data_queue.put(payload)

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
        tonal = [i for i in range(features.shape[0]) if is_tonal_frame(features[i])]
        if len(tonal) < 2:
            return []
        perf = features[tonal]

        follower = self.matchmaker.score_follower
        reference = self.matchmaker.reference_features
        n_ref = reference.shape[0]
        live_end = int(min(max(getattr(follower, "_current_frame", n_ref - 1), 0), n_ref - 1))
        window = OFFLINE_END_SEARCH_SECONDS * FRAME_RATE
        end_lo = max(1, live_end - window)
        end_hi = min(n_ref, live_end + window + 1)

        # Accumulated costs over the widest candidate reference span, then the best end in the
        # window. Normalized by path length so a longer reference isn't penalized just for
        # being longer.
        cost = librosa.sequence.dtw(X=reference[:end_hi].T, Y=perf.T, metric="cityblock", backtrack=False)
        final_column = cost[:, -1]
        candidates = np.arange(end_lo, end_hi)
        normalized = final_column[candidates] / (candidates + 1 + perf.shape[0])
        end = int(candidates[int(np.argmin(normalized))])

        _, path = librosa.sequence.dtw(X=reference[: end + 1].T, Y=perf.T, metric="cityblock", backtrack=True)
        path = path[::-1]

        ref_frame_to_beat = follower._ref_frame_to_beat
        hop = processor.hop_length
        centre_offset = processor.n_fft / 2
        # DTW paths map several reference frames onto one performance frame (and vice versa);
        # collapse to one point per performance frame at the middle of its reference span.
        spans: dict[int, list[int]] = {}
        for ref_idx, perf_idx in path:
            spans.setdefault(int(perf_idx), []).append(int(ref_idx))

        points: list[tuple[float, float]] = []
        for perf_idx in sorted(spans):
            refs = spans[perf_idx]
            ref_idx = refs[len(refs) // 2]
            beat = float(ref_frame_to_beat[min(ref_idx, len(ref_frame_to_beat) - 1)])
            original_frame = tonal[perf_idx]
            perf_time = (original_frame * hop + centre_offset) / self.sample_rate
            points.append((perf_time, convert_beat_to_quarter(self.score_part, beat)))
        return points

    def frame_stats(self) -> tuple[int, int]:
        """(accepted, rejected) live frames so far -- see _GatedArztFollower."""
        follower = self.matchmaker.score_follower
        return getattr(follower, "accepted_frames", 0), getattr(follower, "rejected_frames", 0)

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
