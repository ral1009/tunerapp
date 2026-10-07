"""Package replay results for the intonation-map page (scratchpad/intonation-map)."""
import json
import shutil
import sys
import wave
from pathlib import Path

REC = Path("server/tmp/recordings")
OUT = Path(sys.argv[1])
(OUT / "data").mkdir(parents=True, exist_ok=True)
(OUT / "scores").mkdir(parents=True, exist_ok=True)

manifest_src = json.loads(Path("server/recordings.json").read_text(encoding="utf-8"))["recordings"]
pretty = {
    "bwv1004-giga": ("Partita No. 2 · Giga", "Giga"),
    "bwv1004-corrente": ("Partita No. 2 · Corrente", "Corrente"),
    "bwv1004-allemanda-qmul": ("Partita No. 2 · Allemanda (QMUL)", "Allemanda · QMUL"),
    "bwv1004-allemanda-vicond": ("Partita No. 2 · Allemanda (Vicond)", "Allemanda · Vicond"),
    "bwv1006-menuet1": ("Partita No. 3 · Menuet I", "Menuet I"),
    "paganini-caprice1": ("Paganini · Caprice No. 1", "Caprice 1"),
    "paganini-caprice2-norepeat": ("Paganini · Caprice No. 2", "Caprice 2"),
    "paganini-caprice3-norepeat": ("Paganini · Caprice No. 3 (score unreliable)", "Caprice 3"),
}
manifest = []
for entry in manifest_src:
    name = entry["name"]
    verdicts_file = REC / f"{name}.verdicts.json"
    replay_file = REC / f"{name}.replay.json"
    if not verdicts_file.exists() or not replay_file.exists():
        print("skip", name)
        continue
    replay = json.loads(replay_file.read_text(encoding="utf-8"))
    with wave.open(str(REC / replay["wav"])) as w:
        duration = w.getnframes() / w.getframerate()
    (OUT / "data" / f"{name}.json").write_text(json.dumps({
        "verdicts": json.loads(verdicts_file.read_text(encoding="utf-8")),
        "recordingTuningCents": replay["recordingTuningCents"],
        "durationSeconds": duration,
    }), encoding="utf-8")
    shutil.copy(REC / Path(entry["score"]).with_suffix(".musicxml"), OUT / "scores" / f"{name}.musicxml")
    performer = entry["audio_license"].split("performer: ")[-1] if "performer:" in entry["audio_license"] else "Unknown performer, Queen Mary University of London"
    if name not in pretty:
        print("skip (no title)", name)
        continue
    title, short = pretty.get(name, (name, name))
    manifest.append({"name": name, "title": title, "short": short, "heldOut": entry["held_out"], "performer": performer})
for profile, label, who in [
    ("careful", "Careful", "Simulated beginner: tunes with a tuner, an occasional slip"),
    ("flat-habit", "Flat habit", "Simulated beginner: every fingered note about 20 cents flat"),
    ("self-tuned", "Tuned by ear", "Simulated beginner: whole violin tuned 15 cents flat by ear"),
]:
    name = f"beginner-twinkle-{profile}"
    replay = json.loads((REC / f"{name}.replay.json").read_text(encoding="utf-8"))
    with wave.open(str(REC / replay["wav"])) as w:
        duration = w.getnframes() / w.getframerate()
    (OUT / "data" / f"{name}.json").write_text(json.dumps({
        "verdicts": json.loads((REC / f"{name}.verdicts.json").read_text(encoding="utf-8")),
        "truth": json.loads((REC / f"{name}.truth.json").read_text(encoding="utf-8")),
        "recordingTuningCents": replay["recordingTuningCents"],
        "durationSeconds": duration,
    }), encoding="utf-8")
    xml = (REC / f"{name}.musicxml").read_text(encoding="utf-8")
    (OUT / "scores" / f"{name}.musicxml").write_text(xml, encoding="utf-8")
    manifest.append({"name": name, "title": f"Twinkle · beginner, {label.lower()}", "short": f"Twinkle · {label}", "heldOut": False, "simulated": True, "performer": who})
(OUT / "data" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
print(json.dumps(manifest, indent=1))
