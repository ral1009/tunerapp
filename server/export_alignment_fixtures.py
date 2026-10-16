"""Dump what the server's alignment computes, step by step, so the on-device port can be checked
against it (practice/__tests__/device-align-harness.ts, `npm run deviceAlignTest`).

For each case: partitura's note list and tempo, the reference audio and its chroma, every live
chroma frame with its gate inputs and decisions, the live follower's frame after each step, and
the post-take path. The live pass is driven synchronously, chunk by chunk, through the same
objects LiveAligner uses (stream._process_feature, then the follower), so nothing depends on
thread timing. Output: server/tmp/fixtures/<case>/ (gitignored).

    python server/export_alignment_fixtures.py            # all cases whose files are present
    python server/export_alignment_fixtures.py twinkle    # cases whose name contains "twinkle"
"""
from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")
BASE_DIR = Path(__file__).resolve().parent
REPO = BASE_DIR.parent
sys.path.insert(0, str(BASE_DIR))

import librosa  # noqa: E402
import soundfile as sf  # noqa: E402

from matchmaker_service import LiveAligner, frame_band_stats, score_hash  # noqa: E402

RECORDINGS = BASE_DIR / "tmp" / "recordings"
OUT = BASE_DIR / "tmp" / "fixtures"


def recording_case(name: str, seeks: list[tuple[float, float]] | None = None, score: str | None = None) -> dict | None:
    xml = RECORDINGS / f"{score or name}.musicxml"
    wav = RECORDINGS / f"{name}.wav"
    if not (xml.exists() and wav.exists()):
        return None
    replay = RECORDINGS / f"{name}.replay.json"
    return {
        "name": name + ("-jump" if seeks else ""),
        "xml": xml.read_text(encoding="utf-8"),
        "wav": wav,
        "seeks": seeks or [],
        "grading": {"kind": "replay", "path": str(replay)} if replay.exists() else None,
    }


def take_case(stem: str, name: str, seeks: list[tuple[float, float]] | None = None) -> dict | None:
    meta = REPO / ".scratch" / f"{stem}.json"
    wav = REPO / ".scratch" / f"{stem}.wav"
    if not (meta.exists() and wav.exists()):
        return None
    return {
        "name": name,
        "xml": json.loads(meta.read_text(encoding="utf-8"))["scoreXml"],
        "wav": wav,
        "seeks": seeks or [],
        "grading": {"kind": "take", "path": str(meta)},
    }


def cases() -> list[dict]:
    found = [
        recording_case("beginner-twinkle-careful"),
        recording_case("beginner-d-scale-flat-habit"),
        recording_case("beginner-lightly-row-self-tuned"),
        recording_case("bwv1004-giga"),
        recording_case("bwv1006-menuet1"),  # repeats: partitura unfolds them
        # Seconds into the audio -> quarter to jump to: back to the start, mid-take.
        recording_case("beginner-twinkle-careful", seeks=[(14.0, 0.0)]),
        take_case("take-2026-10-08T15-47-10-512Z", "user-take-a"),
        take_case("take-2026-10-08T19-49-39-151Z", "user-take-b"),
        # Held out for npm run alignStressTest -- --all (added 2026-10-16, unseen until then).
        recording_case("bwv1004-corrente"),
        recording_case("bwv1004-allemanda-qmul", score="bwv1004-allemanda"),
        recording_case("bwv1004-allemanda-vicond", score="bwv1004-allemanda"),
    ]
    return [c for c in found if c is not None]


def f32(path: Path, array: np.ndarray) -> None:
    np.ascontiguousarray(array, dtype="<f4").tofile(path)


def export(case: dict) -> None:
    out = OUT / case["name"]
    out.mkdir(parents=True, exist_ok=True)
    audio, sr = sf.read(str(case["wav"]), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    xml = case["xml"]
    digest = score_hash(xml)
    score_path = BASE_DIR / "tmp" / "scores" / f"{digest}.musicxml"
    score_path.parent.mkdir(parents=True, exist_ok=True)
    score_path.write_text(xml, encoding="utf-8")
    (out / "score.musicxml").write_text(xml, encoding="utf-8")

    aligner = LiveAligner(score_path, digest, sr)
    mm = aligner.matchmaker
    part = aligner.score_part
    processor = mm.processor
    follower = mm.score_follower
    stream = mm.stream
    hop = aligner.hop_length
    n_fft = processor.n_fft

    # Partitura's view of the score, as the reference is built from it (unfolded, merged).
    na = part.note_array()
    notes = [
        {
            "pitch": int(n["pitch"]),
            "onsetQuarter": float(part.quarter_map(part.inv_beat_map(n["onset_beat"]))),
            "durationQuarter": float(n["duration_quarter"]),
        }
        for n in na
    ]
    ref_frame_quarter = np.asarray(part.quarter_map(part.inv_beat_map(np.asarray(follower._ref_frame_to_beat))), dtype=float)
    reference = np.asarray(mm.reference_features, dtype=np.float32)

    # The reference audio and its whole-signal tuning, for checking the synth and chroma separately.
    from matchmaker_service import additive_score_audio

    ref_audio = additive_score_audio(part, mm.tempo, sr)
    ref_S = np.abs(librosa.stft(ref_audio, n_fft=n_fft, hop_length=hop, center=False)) ** 2
    ref_tuning = float(librosa.estimate_tuning(S=ref_S, sr=sr, bins_per_octave=12))

    # Live pass, synchronously: the same steps push_chunk + the stream thread + the follower do.
    follower.reset()
    follower.queue_timeout = None
    seeks = sorted(case["seeks"])
    seek_chunks = [(int(round(t * sr / hop)), q) for t, q in seeks]
    live_chroma: list[np.ndarray] = []
    live_low: list[float] = []
    live_rms: list[float] = []
    live_tuning: list[float] = []
    released_per_chunk: list[int] = []
    follower_frames: list[int] = []  # _current_frame after each item the follower stepped
    accepted_after: list[int] = []
    chunk_index = 0
    for s in range(0, len(audio) - hop + 1, hop):
        for k, q in seek_chunks:
            if k == chunk_index:
                aligner.seek(q)
        chunk = audio[s:s + hop]
        aligner._recorded_chunks.append(chunk.tobytes())
        aligner._recorded_samples += hop
        before = stream.queue.qsize()
        had_last = stream.last_chunk is not None
        stream._process_feature(chunk, 0.0)
        if had_last:
            # The frame the stream just analysed: the previous n_fft - hop samples plus this chunk.
            frame = np.frombuffer(b"".join(aligner._recorded_chunks[-2:]), dtype=np.float32)[-n_fft:]
            S = np.abs(librosa.stft(frame, n_fft=n_fft, hop_length=hop, center=False)) ** 2
            live_tuning.append(float(librosa.estimate_tuning(S=S, sr=sr, bins_per_octave=12)))
            windowed = frame * np.hanning(n_fft + 1)[:-1].astype(np.float32)
            power = (np.abs(np.fft.rfft(windowed)) ** 2)[None, :]
            low, rms = frame_band_stats(power, sr, n_fft)
            live_low.append(float(low[0]))
            live_rms.append(float(rms[0]))
            live_chroma.append(np.asarray(processor((frame, 0.0))[0][-1], dtype=np.float32))
        released = stream.queue.qsize() - before
        released_per_chunk.append(released)
        for _ in range(released):
            item = stream.queue.get_nowait()
            follower(*item)
            follower_frames.append(int(follower._current_frame))
            accepted_after.append(int(follower.accepted_frames))
        chunk_index += 1

    offline = aligner.compute_offline_alignment()
    # The post-take pass's own inputs, to test the DTW separately from the chroma: the take's
    # features (one tuning for the whole take) and the frames its gate kept.
    take = np.frombuffer(b"".join(aligner._recorded_chunks), dtype=np.float32)
    take_features, _ = processor((take, 0.0))
    take_S = np.abs(librosa.stft(take, n_fft=n_fft, hop_length=hop, center=False)) ** 2
    take_tuning = float(librosa.estimate_tuning(S=take_S, sr=sr, bins_per_octave=12))
    take_power = take_S.T
    low, rms = frame_band_stats(take_power[: take_features.shape[0]], sr, n_fft)
    from matchmaker_service import PlayingGate

    take_gate = PlayingGate()
    take_tonal: list[int] = []
    for i in range(min(take_features.shape[0], low.shape[0])):
        take_tonal.extend(take_gate.push(i, take_features[i], float(low[i]), float(rms[i])))

    f32(out / "audio.f32", audio)
    f32(out / "ref_audio.f32", ref_audio)
    f32(out / "ref_chroma.f32", reference)
    f32(out / "take_chroma.f32", np.asarray(take_features, dtype=np.float32))
    f32(out / "live_chroma.f32", np.asarray(live_chroma, dtype=np.float32).reshape(-1, 12) if live_chroma else np.zeros((0, 12)))
    meta = {
        "name": case["name"],
        "sampleRate": sr,
        "hop": hop,
        "nFft": n_fft,
        "tempo": float(mm.tempo),
        "quarterOrigin": aligner.quarter_origin,
        "totalQuarters": aligner.total_quarters,
        "notes": notes,
        "refFrames": int(reference.shape[0]),
        "refFrameQuarter": ref_frame_quarter.tolist(),
        "refTuning": ref_tuning,
        "audioSamples": int(len(audio)),
        "seeks": [{"chunk": k, "quarter": q} for k, q in seek_chunks],
        "liveTuning": live_tuning,
        "liveLow": live_low,
        "liveRms": live_rms,
        "releasedPerChunk": released_per_chunk,
        "followerFrames": follower_frames,
        "acceptedAfter": accepted_after,
        "gate": {"accepted": stream.gate.accepted, "rejected": stream.gate.rejected},
        "offlinePath": [[t, q] for t, q in offline],
        "takeTuning": take_tuning,
        "takeTonal": take_tonal,
        "liveFinal": int(follower._current_frame),
        "grading": case.get("grading"),
    }
    (out / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(
        f"{case['name']}: {len(notes)} notes, ref {reference.shape[0]} frames, live {len(live_chroma)} frames, "
        f"follower steps {len(follower_frames)}, path {len(offline)} points, tempo {mm.tempo:g}"
    )


def main(filters: list[str]) -> int:
    chosen = [c for c in cases() if not filters or any(f in c["name"] for f in filters)]
    if not chosen:
        print("no cases found (recordings live in server/tmp/recordings, takes in .scratch)")
        return 1
    for case in chosen:
        export(case)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
