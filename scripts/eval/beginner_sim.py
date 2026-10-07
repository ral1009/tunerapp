"""Simulated beginner takes with per-note ground truth, run through the real alignment path.

Writes server/tmp/recordings/beginner-<piece>-<profile>.{musicxml,wav,replay.json,truth.json}.
"""
import json
import sys
import threading
import warnings
from pathlib import Path

import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore")
sys.path.insert(0, "server")
from matchmaker_service import LiveAligner, score_hash, warm_up  # noqa: E402
from replay_check import note_list  # noqa: E402

OUT = Path("server/tmp/recordings")
SR = 44100
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
OPEN = {55, 62, 69, 76}  # G3 D4 A4 E5

# (note, beats). Sharps follow the key (A major: F# C# G#; D major: F# C#).
PIECES = {
    "twinkle": ("A", 3, [("A4", 1), ("A4", 1), ("E5", 1), ("E5", 1), ("F#5", 1), ("F#5", 1), ("E5", 2),
                         ("D5", 1), ("D5", 1), ("C#5", 1), ("C#5", 1), ("B4", 1), ("B4", 1), ("A4", 2),
                         ("E5", 1), ("E5", 1), ("D5", 1), ("D5", 1), ("C#5", 1), ("C#5", 1), ("B4", 2),
                         ("E5", 1), ("E5", 1), ("D5", 1), ("D5", 1), ("C#5", 1), ("C#5", 1), ("B4", 2),
                         ("A4", 1), ("A4", 1), ("E5", 1), ("E5", 1), ("F#5", 1), ("F#5", 1), ("E5", 2),
                         ("D5", 1), ("D5", 1), ("C#5", 1), ("C#5", 1), ("B4", 1), ("B4", 1), ("A4", 2)]),
    "lightly-row": ("A", 3, [("E5", 1), ("C#5", 1), ("C#5", 2), ("D5", 1), ("B4", 1), ("B4", 2),
                             ("A4", 1), ("B4", 1), ("C#5", 1), ("D5", 1), ("E5", 1), ("E5", 1), ("E5", 2),
                             ("E5", 1), ("C#5", 1), ("C#5", 2), ("D5", 1), ("B4", 1), ("B4", 2),
                             ("A4", 1), ("C#5", 1), ("E5", 1), ("E5", 1), ("C#5", 4)]),
    "d-scale": ("D", 2, [(n, 1) for n in ["D4", "E4", "F#4", "G4", "A4", "B4", "C#5", "D5", "D5", "C#5", "B4", "A4", "G4", "F#4", "E4"]] + [("D4", 2)]),
}

# Per-note true error, in cents from A440 equal temperament.
PROFILES = {
    # Tunes with a tuner; fingers mostly close, an occasional real slip.
    "careful": dict(instrument=0, sd=7, bias=-3, slip_rate=0.12),
    # Tunes with a tuner but has a habit: every fingered note ~20 cents flat.
    "flat-habit": dict(instrument=0, sd=6, bias=-20, slip_rate=0.10),
    # Tuned by ear 15 cents flat overall, otherwise like "careful".
    "self-tuned": dict(instrument=-15, sd=7, bias=-3, slip_rate=0.12),
}


def midi_of(name):
    step, rest = name[0], name[1:]
    alter = 1 if rest.startswith("#") else 0
    octave = int(rest[1:] if alter else rest)
    return 12 * (octave + 1) + STEP[step] + alter


def build_xml(key, fifths, notes, tempo=72):
    divisions = 2
    measures, current, filled = [], [], 0
    for name, beats in notes:
        current.append((name, beats))
        filled += beats
        if filled >= 4:
            measures.append(current); current, filled = [], 0
    if current:
        measures.append(current)
    out = []
    for i, measure in enumerate(measures):
        body = []
        if i == 0:
            body.append(f"""      <attributes><divisions>{divisions}</divisions><key><fifths>{fifths}</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>{tempo}</per-minute></metronome></direction-type><sound tempo="{tempo}"/></direction>""")
        for name, beats in measure:
            alter = "<alter>1</alter>" if "#" in name else ""
            octave = name[-1]
            body.append(f"      <note><pitch><step>{name[0]}</step>{alter}<octave>{octave}</octave></pitch><duration>{beats * divisions}</duration><voice>1</voice></note>")
        out.append(f'    <measure number="{i + 1}">\n' + "\n".join(body) + "\n    </measure>")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">
{chr(10).join(out)}
  </part>
</score-partwise>
"""


def render(notes, errors, rng, tempo=72):
    beat = 60 / tempo
    gains = np.array([1.0, 0.75, 0.6, 0.45, 0.4, 0.3, 0.22, 0.18, 0.12, 0.1])
    pieces = [np.zeros(int(0.5 * SR))]
    for (name, beats), err in zip(notes, errors):
        dur = beats * beat * rng.uniform(0.9, 1.12)  # uneven beginner timing
        n = int(dur * SR)
        t = np.arange(n) / SR
        f0 = 440 * 2 ** ((midi_of(name) - 69) / 12) * 2 ** (err / 1200)
        # Attack scoop: starts ~25 cents flat and settles over 70 ms.
        scoop = -25 * np.exp(-t / 0.035)
        wobble = 3 * np.sin(2 * np.pi * rng.uniform(0.3, 0.8) * t)  # unsteady bow, no vibrato
        inst = f0 * 2 ** ((scoop + wobble) / 1200)
        phase = 2 * np.pi * np.cumsum(inst) / SR
        tone = sum(g * rng.uniform(0.7, 1.3) * np.sin((h + 1) * phase) for h, g in enumerate(gains) if (h + 1) * f0 < 9000)
        env = np.minimum(1, t / 0.04) * np.minimum(1, (dur - t) / 0.05).clip(0)
        scratch = rng.normal(0, 0.25, n) * np.exp(-t / 0.03)  # bow noise at the attack
        note = 0.12 * (tone * env) + 0.04 * scratch
        gap = np.zeros(int(rng.uniform(0.03, 0.09) * SR))  # bow changes
        pieces += [note, gap]
    pieces.append(np.zeros(int(0.5 * SR)))
    audio = np.concatenate(pieces)
    ir = rng.normal(0, 1, int(0.35 * SR)) * np.exp(-np.arange(int(0.35 * SR)) / (0.08 * SR))
    wet = np.convolve(audio, ir)[: len(audio)]
    audio = audio + 0.25 * wet / np.max(np.abs(wet)) * np.max(np.abs(audio)) + rng.normal(0, 0.002, len(audio))
    return (0.8 * audio / np.max(np.abs(audio))).astype(np.float32)


def main():
    warm_up()
    rng = np.random.default_rng(2026)
    for piece, (key, fifths, notes) in PIECES.items():
        xml = build_xml(key, fifths, notes)
        for profile, p in PROFILES.items():
            name = f"beginner-{piece}-{profile}"
            errors, truth = [], []
            for note, _ in notes:
                is_open = midi_of(note) in OPEN
                e = p["instrument"] + rng.normal(0, 2) if is_open else p["instrument"] + rng.normal(p["bias"], p["sd"])
                slip = (not is_open) and rng.random() < p["slip_rate"]
                if slip:
                    e += rng.choice([-1, 1]) * rng.uniform(35, 60)
                errors.append(float(e)); truth.append({"midi": midi_of(note), "cents": float(e), "open": is_open, "slip": bool(slip)})
            audio = render(notes, errors, rng)
            (OUT / f"{name}.musicxml").write_text(xml, encoding="utf-8")
            sf.write(str(OUT / f"{name}.wav"), audio, SR, subtype="PCM_16")
            digest = score_hash(xml)
            path = Path("server/tmp/scores") / f"{digest}.musicxml"
            path.write_text(xml, encoding="utf-8")
            aligner = LiveAligner(path, digest, SR)
            worker = threading.Thread(target=lambda: aligner.run(lambda q, b: None), daemon=True)
            worker.start()
            hop = aligner.hop_length
            for s in range(0, len(audio) - hop + 1, hop):
                aligner.push_chunk(audio[s:s + hop].tobytes())
            aligner.push_sentinel(); worker.join(timeout=300)
            offline = aligner.compute_offline_alignment()
            score_notes = note_list(aligner.score_part)
            assert len(score_notes) == len(notes), (name, len(score_notes), len(notes))
            (OUT / f"{name}.replay.json").write_text(json.dumps({
                "name": name, "heldOut": False, "sampleRate": SR, "wav": f"{name}.wav",
                "path": [{"perfTimeSeconds": t, "quarter": q} for t, q in offline],
                "notes": score_notes, "recordingTuningCents": p["instrument"],
            }), encoding="utf-8")
            (OUT / f"{name}.truth.json").write_text(json.dumps(truth), encoding="utf-8")
            print(name, f"{len(notes)} notes, {len(audio) / SR:.1f}s, aligned to q={offline[-1][1]:.1f}")


main()
