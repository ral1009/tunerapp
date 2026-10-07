"""Find each caprice inside the 72-minute concert by subsequence DTW on the alignment's own features."""
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore")
sys.path.insert(0, "server")
import librosa  # noqa: E402
import partitura as pt  # noqa: E402
from matchmaker_service import LiveAligner, score_hash, warm_up  # noqa: E402

D = Path("server/tmp/recordings/paganini")
audio, sr = sf.read(str(D / "madoyan.wav"), dtype="float32")
warm_up()
DOWN = 3  # 30 fps features -> 10 fps for the search

concert = None
found = {}
for n in [1, 2, 3, 23, 24]:
    xml_path = D / f"caprice{n}.musicxml"
    if not xml_path.exists():
        pt.save_musicxml(pt.load_score_midi(str(D / f"caprice{n}.mid")), str(xml_path))
    xml = xml_path.read_text(encoding="utf-8")
    digest = score_hash(xml)
    copy = Path("server/tmp/scores") / f"{digest}.musicxml"
    copy.write_text(xml, encoding="utf-8")
    aligner = LiveAligner(copy, digest, sr)
    if concert is None:
        feats, _ = aligner.matchmaker.processor((audio, 0.0))
        concert = feats
        print("concert features", concert.shape, flush=True)
    ref = aligner.matchmaker.reference_features
    pool = lambda f: f[: len(f) // DOWN * DOWN].reshape(-1, DOWN, f.shape[1]).mean(axis=1)
    R, C = pool(ref), pool(concert)
    cost, path = librosa.sequence.dtw(X=R.T, Y=C.T, metric="cityblock", subseq=True, backtrack=True)
    end = int(np.argmin(cost[-1]))
    path = path[::-1]
    start = int(path[0][1])
    fps = 30 / DOWN
    found[n] = {"start": start / fps, "end": end / fps, "cost": float(cost[-1, end] / len(R))}
    print(f"caprice {n}: {start / fps / 60:5.2f}-{end / fps / 60:5.2f} min ({(end - start) / fps:.0f}s), "
          f"reference {len(ref) / 30:.0f}s at MIDI tempo, normalized cost {found[n]['cost']:.2f}", flush=True)

(D / "segments.json").write_text(json.dumps(found, indent=1))
