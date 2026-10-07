"""Replay real recordings of real pieces through the alignment service -- no microphone needed.

Run manually: ``python server/replay_check.py [name ...]``, then ``npm run replayScore`` to grade
the same takes with the app's own intonation scorer. Same convention as ``offline_check.py``: no
test framework, real signal through the real code path.

Pieces are listed in ``server/recordings.json`` (source URLs, licences, which ones are held out).
The audio and score files themselves live in ``server/tmp/recordings/`` (gitignored) -- fetch them
from the URLs in the manifest. A ``.mid`` score is converted to MusicXML with partitura; a
non-WAV recording is decoded with ffmpeg (must be on PATH).

There is no ground truth for when each note was played, so every number here is a plausibility
check, not an accuracy measurement:

- forward-only motion, and reaching the end of the score around the end of the recording;
- live vs post-take agreement -- two different algorithms (causal online time warping vs global
  DTW) reaching the same placement is evidence both are right;
- pitch agreement: an independent pitch tracker (librosa's pYIN, sharing nothing with the app)
  is asked whether the audio inside each note's aligned span sounds like the written note.
  Compared against a constant-tempo "no alignment" baseline, and against the same alignment
  shifted +-40 ms (if the peak is not at 0, placement is systematically early or late).

pYIN's own ceiling is well below 100% on fast passages (string crossings ring into each other),
so compare runs against each other, not against 100%.

``held_out: true`` pieces must not be used to tune anything. Look at them only after a change
is finished, to check it generalizes.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
import time
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))
RECORDINGS_DIR = BASE_DIR / "tmp" / "recordings"
MANIFEST = BASE_DIR / "recordings.json"

import librosa  # noqa: E402
import partitura as pt  # noqa: E402
import soundfile as sf  # noqa: E402

from matchmaker_service import LiveAligner, score_hash, warm_up  # noqa: E402

PYIN_SR = 22050
PYIN_HOP = 256


def load_score_xml(entry: dict) -> str:
    score_file = RECORDINGS_DIR / entry["score"]
    if score_file.suffix.lower() in (".mid", ".midi"):
        xml_path = score_file.with_suffix(".musicxml")
        if not xml_path.exists():
            pt.save_musicxml(pt.load_score_midi(str(score_file)), str(xml_path))
        return xml_path.read_text(encoding="utf-8")
    return score_file.read_text(encoding="utf-8")


def load_audio(entry: dict) -> tuple[np.ndarray, int]:
    audio_file = RECORDINGS_DIR / entry["audio"]
    if audio_file.suffix.lower() != ".wav":
        wav = audio_file.with_suffix(".wav")
        if not wav.exists():
            if not shutil.which("ffmpeg"):
                raise RuntimeError(f"ffmpeg is needed to decode {audio_file.name}")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(audio_file), "-ac", "1", str(wav)], check=True)
        audio_file = wav
    audio, sr = sf.read(str(audio_file), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio, sr


def note_list(part) -> list[dict]:
    """One entry per onset: ties merged, double stops collapsed to the top note (the melody)."""
    by_onset: dict[float, dict] = {}
    for n in part.notes_tied:
        q = float(part.quarter_map(n.start.t))
        dur = float(part.quarter_map(n.start.t + n.duration_tied) - q)
        cur = by_onset.get(q)
        if cur is None or n.midi_pitch > cur["midi"]:
            by_onset[q] = {"quarter": q, "midi": int(n.midi_pitch), "dur": dur}
    notes = [by_onset[q] for q in sorted(by_onset)]
    for i, n in enumerate(notes):
        n["stepIndex"] = i
    return notes


def time_of_quarter(path: list[tuple[float, float]], q: float) -> float | None:
    t = np.array([p[0] for p in path])
    qs = np.maximum.accumulate(np.array([p[1] for p in path]))
    if q < qs[0] or q > qs[-1]:
        return None
    return float(np.interp(q, qs, t))


def pitch_agreement(path, notes, f0_times, f0_midi, total_q) -> dict:
    hits = octave = wrong = unvoiced = unplaced = 0
    for i, n in enumerate(notes):
        end_q = notes[i + 1]["quarter"] if i + 1 < len(notes) else total_q
        t0, t1 = time_of_quarter(path, n["quarter"]), time_of_quarter(path, end_q)
        if t0 is None or t1 is None or t1 <= t0:
            unplaced += 1
            continue
        # Middle 60% of the span, so a small timing error doesn't decide the outcome on its own.
        a, b = t0 + 0.2 * (t1 - t0), t1 - 0.2 * (t1 - t0)
        sel = (f0_times >= a) & (f0_times <= b) & np.isfinite(f0_midi)
        if not sel.any():
            unvoiced += 1
            continue
        d = float(np.median(f0_midi[sel])) - n["midi"]
        if abs(d) <= 0.5:
            hits += 1
        elif abs(abs(d) - 12) <= 0.5:
            octave += 1
        else:
            wrong += 1
    judged = hits + octave + wrong
    return {"rate": hits / judged if judged else 0.0, "match": hits, "octave": octave, "wrong": wrong,
            "unvoiced": unvoiced, "unplaced": unplaced}


def replay(entry: dict) -> dict:
    name = entry["name"]
    xml = load_score_xml(entry)
    audio, sr = load_audio(entry)
    duration = len(audio) / sr

    digest = score_hash(xml)
    score_copy = BASE_DIR / "tmp" / "scores" / f"{digest}.musicxml"
    score_copy.parent.mkdir(parents=True, exist_ok=True)
    score_copy.write_text(xml, encoding="utf-8")

    started = time.time()
    aligner = LiveAligner(score_copy, digest, sr)
    prep_s = time.time() - started
    part = aligner.score_part
    notes = note_list(part)
    total_q = aligner.total_quarters

    # Live pass, chunked exactly like the browser. Pushed as fast as the follower takes it; the
    # result is read from the follower's own alignment_path, which doesn't depend on push rate
    # (sampling positions at push time measures backlog, not tracking -- see CLAUDE.md).
    worker = threading.Thread(target=lambda: aligner.run(lambda q, b: None), daemon=True)
    worker.start()
    hop = aligner.hop_length
    started = time.time()
    for s in range(0, len(audio) - hop + 1, hop):
        aligner.push_chunk(audio[s:s + hop].tobytes())
    aligner.push_sentinel()
    worker.join(timeout=900)
    live_compute_s = time.time() - started
    beats, times = aligner.matchmaker.score_follower.alignment_path
    live_q = [float(part.quarter_map(part.inv_beat_map(b))) for b in beats]
    # Library labels live frames by window start; shift to window centres like the offline path.
    n_fft = 2048
    live_path = [(float(t) + n_fft / 2 / sr, q) for t, q in zip(times, live_q)]
    backward = sum(1 for a, b in zip(live_q, live_q[1:]) if b < a - 1e-6)

    started = time.time()
    offline = aligner.compute_offline_alignment()
    offline_s = time.time() - started
    off_t = [p[0] for p in offline]
    off_q = np.maximum.accumulate([p[1] for p in offline])
    diffs = np.array([q - np.interp(t, off_t, off_q) for t, q in live_path[::10]])

    y = librosa.resample(audio, orig_sr=sr, target_sr=PYIN_SR)
    f0, voiced, _ = librosa.pyin(y, fmin=180, fmax=2600, sr=PYIN_SR, frame_length=2048, hop_length=PYIN_HOP)
    f0_times = librosa.times_like(f0, sr=PYIN_SR, hop_length=PYIN_HOP)
    f0_midi = np.where(voiced, librosa.hz_to_midi(np.where(np.isfinite(f0), f0, 1.0)), np.nan)
    voiced_t = f0_times[np.isfinite(f0_midi)]
    baseline = [(voiced_t[0], 0.0), (voiced_t[-1], total_q)]
    deviation = (f0_midi - np.round(f0_midi))[np.isfinite(f0_midi)] * 100

    agreement = {
        "offline": pitch_agreement(offline, notes, f0_times, f0_midi, total_q),
        "live": pitch_agreement(live_path, notes, f0_times, f0_midi, total_q),
        "baseline": pitch_agreement(baseline, notes, f0_times, f0_midi, total_q),
        "offline_shift": {
            ms: pitch_agreement([(t + ms / 1000, q) for t, q in offline], notes, f0_times, f0_midi, total_q)["rate"]
            for ms in (-40, 40)
        },
    }

    (RECORDINGS_DIR / f"{name}.replay.json").write_text(json.dumps({
        "name": name,
        "heldOut": bool(entry.get("held_out")),
        "sampleRate": sr,
        "wav": str((RECORDINGS_DIR / entry["audio"]).with_suffix(".wav").name),
        "path": [{"perfTimeSeconds": t, "quarter": q} for t, q in offline],
        "notes": notes,
        "recordingTuningCents": float(np.median(deviation)),
    }), encoding="utf-8")

    return {
        "name": name, "held_out": bool(entry.get("held_out")), "notes": len(notes), "total_q": total_q,
        "duration": duration, "prep_s": prep_s, "live_compute_s": live_compute_s, "offline_s": offline_s,
        "live_final": live_q[-1], "backward": backward, "live_vs_offline": float(np.mean(np.abs(diffs))),
        "live_lag": float(np.mean(diffs)), "agreement": agreement, "tuning": float(np.median(deviation)),
    }


def report(r: dict) -> None:
    a = r["agreement"]
    tag = " [HELD OUT]" if r["held_out"] else ""
    print(f"\n=== {r['name']}{tag}: {r['notes']} notes, {r['total_q']:.1f} qn, {r['duration']:.1f}s audio")
    print(f"  score prep {r['prep_s']:.1f}s | live compute {r['live_compute_s']:.1f}s | post-take alignment {r['offline_s']:.1f}s")
    print(f"  live reached {r['live_final']:.1f}/{r['total_q']:.1f} qn ({100 * r['live_final'] / r['total_q']:.0f}%), "
          f"backward steps {r['backward']}")
    print(f"  live vs post-take: mean |diff| {r['live_vs_offline']:.2f} qn (live lag {r['live_lag']:+.2f} qn)")
    for key, label in (("offline", "post-take"), ("live", "live"), ("baseline", "constant tempo")):
        x = a[key]
        print(f"  pitch agreement, {label:14s}: {100 * x['rate']:5.1f}%  (octave {x['octave']}, wrong {x['wrong']}, "
              f"unvoiced {x['unvoiced']}, unplaced {x['unplaced']})")
    print(f"  post-take shifted -40ms {100 * a['offline_shift'][-40]:.1f}% / +40ms {100 * a['offline_shift'][40]:.1f}% "
          f"(should both be below the unshifted figure)")
    print(f"  recording's tuning vs A440 (pYIN median): {r['tuning']:+.1f} cents")


def main(names: list[str]) -> int:
    if not MANIFEST.exists():
        print(f"No manifest at {MANIFEST}")
        return 1
    entries = json.loads(MANIFEST.read_text(encoding="utf-8"))["recordings"]
    if names:
        entries = [e for e in entries if e["name"] in names]
    warm_up()
    missing = [e["name"] for e in entries
               if not (RECORDINGS_DIR / e["audio"]).exists() or not (RECORDINGS_DIR / e["score"]).exists()]
    for name in missing:
        print(f"skipping {name}: files not in {RECORDINGS_DIR} (see the source URLs in recordings.json)")
    for entry in entries:
        if entry["name"] not in missing:
            report(replay(entry))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
