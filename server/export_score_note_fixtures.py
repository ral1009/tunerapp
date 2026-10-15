"""Partitura's view of every score the server has aligned (server/tmp/scores/*.musicxml), loaded the
way Matchmaker loads one: load_musicxml(ignore_invisible_objects=True), unfold_part_maximal with
the recursion limit raised to 10,000 (falling back to the score as written if that fails, as
Matchmaker does), merge_parts, note_array(), and get_tempo_from_score (else 120 BPM).

Checks the on-device note extractor (score/scoreNotes.ts) against partitura in
`npm run deviceAlignTest`. Output: server/tmp/fixtures/_scores/<hash>.json (gitignored).
"""
from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

import partitura  # noqa: E402
from matchmaker.matchmaker import DEFAULT_TEMPO, get_tempo_from_score  # noqa: E402
from partitura.score import merge_parts  # noqa: E402

SCORES = BASE_DIR / "tmp" / "scores"
OUT = BASE_DIR / "tmp" / "fixtures" / "_scores"


def load_like_matchmaker(path: Path):
    score = partitura.load_musicxml(str(path), ignore_invisible_objects=True)
    previous = sys.getrecursionlimit()
    try:
        sys.setrecursionlimit(max(previous, 10_000))
        part = merge_parts(partitura.score.unfold_part_maximal(score, ignore_leaps=False).parts)
        unfolded = True
    except Exception:  # noqa: BLE001 -- Matchmaker swallows it the same way
        part = merge_parts(score.parts)
        unfolded = False
    finally:
        sys.setrecursionlimit(max(sys.getrecursionlimit(), 10_000))
    return part, unfolded


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    synthetic = BASE_DIR / "tmp" / "fixtures" / "_synthetic"
    for path in sorted(SCORES.glob("*.musicxml")) + sorted(synthetic.glob("*.musicxml")):
        try:
            part, unfolded = load_like_matchmaker(path)
        except Exception as error:  # noqa: BLE001
            print(f"{path.stem[:12]}: partitura couldn't load it ({error})")
            continue
        tempo = get_tempo_from_score(part, str(path))
        na = part.note_array()
        notes = [
            {
                "pitch": int(n["pitch"]),
                "onsetQuarter": float(part.quarter_map(part.inv_beat_map(n["onset_beat"]))),
                "durationQuarter": float(n["duration_quarter"]),
            }
            for n in na
        ]
        (OUT / f"{path.stem}.json").write_text(
            json.dumps({
                "score": str(path),
                "unfolded": unfolded,
                "tempo": float(tempo) if tempo is not None else float(DEFAULT_TEMPO),
                "tempoFromScore": tempo is not None,
                "notes": notes,
            }),
            encoding="utf-8",
        )
        print(f"{path.stem[:12]}: {len(notes)} notes, tempo {tempo}, {'unfolded' if unfolded else 'as written'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
