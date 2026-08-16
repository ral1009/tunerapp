from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import xml.etree.ElementTree as ET

BASE_DIR = Path(__file__).resolve().parent
TMP_ROOT = BASE_DIR / "tmp"
TMP_ROOT.mkdir(parents=True, exist_ok=True)

HOMR_TIMEOUT_SECONDS = int(os.environ.get("HOMR_TIMEOUT_SECONDS", "60"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("homr_sheet_parser")

app = FastAPI(title="HOMR Sheet Parser")
app.add_middleware(
    CORSMiddleware,
    # Normal browser traffic goes through Vite's dev-server proxy (see vite.config.ts) as a
    # same-origin request, which needs no CORS allowance at all. This allowlist only matters for
    # direct requests to this server (e.g. curl, or a client that bypasses the proxy) -- kept
    # permissive across localhost/127.0.0.1/any private-LAN IP on Vite's dev port since this
    # server is local-dev-only, not deployed.
    allow_origin_regex=r"https://(localhost|127\.0\.0\.1|(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.[\d.]+):5173",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _note_name_to_frequency(note_name: str) -> float | None:
    match = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d+)", note_name)
    if not match:
        return None

    letter, accidental, octave_str = match.groups()
    note_map = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    semitone = note_map[letter.upper()]
    if accidental == "#":
        semitone += 1
    elif accidental == "b":
        semitone -= 1

    octave = int(octave_str)
    midi_number = (octave + 1) * 12 + semitone
    return 440.0 * (2.0 ** ((midi_number - 69) / 12.0))


def _extract_notes_from_musicxml(xml_path: Path) -> list[dict[str, Any]]:
    tree = ET.parse(xml_path)
    root = tree.getroot()

    notes: list[dict[str, Any]] = []
    primary_voice: str | None = None
    for note_element in root.findall(".//note"):
        if note_element.find("rest") is not None:
            continue

        # Mirrors score/musicxmlImport.ts: this app tracks a single melodic line, so once a
        # voice is seen, notes tagged with a different voice (a second layer/part) are skipped.
        voice_element = note_element.find("voice")
        voice_text = voice_element.text if voice_element is not None else None
        if voice_text is not None:
            if primary_voice is None:
                primary_voice = voice_text
            elif voice_text != primary_voice:
                continue

        pitch = note_element.find("pitch")
        if pitch is None:
            continue

        step = pitch.findtext("step")
        octave = pitch.findtext("octave")
        if not step or octave is None:
            continue

        alter_value = pitch.findtext("alter")
        note_name = step
        if alter_value is not None and alter_value != "0":
            if int(alter_value) > 0:
                note_name += "#"
            else:
                note_name += "b"

        note_label = f"{note_name}{octave}"
        notes.append({
            "name": note_label,
            "frequency": _note_name_to_frequency(note_label),
        })

    return notes


@app.post("/api/parse-sheet")
async def parse_sheet(file: UploadFile = File(...)) -> JSONResponse:
    if not file.filename:
        return JSONResponse(status_code=400, content={"error": "No file was provided."})

    temp_dir = TMP_ROOT / str(uuid.uuid4())
    temp_dir.mkdir(parents=True, exist_ok=True)
    uploaded_path = temp_dir / Path(file.filename).name
    created_paths = [uploaded_path]

    try:
        contents = await file.read()
        uploaded_path.write_bytes(contents)

        result = subprocess.run(
            ["uvx", "homr", str(uploaded_path)],
            capture_output=True,
            timeout=HOMR_TIMEOUT_SECONDS,
            text=True,
        )

        if result.returncode != 0:
            logger.error(
                "homr exited with code %s for %s\nstdout: %s\nstderr: %s",
                result.returncode,
                file.filename,
                result.stdout,
                result.stderr,
            )
            return JSONResponse(status_code=502, content={"error": "HOMR failed to parse the sheet image."})

        xml_candidates = sorted(temp_dir.glob("*.musicxml"))
        if not xml_candidates:
            logger.error(
                "homr produced no .musicxml output for %s\nstdout: %s\nstderr: %s",
                file.filename,
                result.stdout,
                result.stderr,
            )
            return JSONResponse(status_code=422, content={"error": "No MusicXML output was generated."})

        xml_path = xml_candidates[0]
        created_paths.append(xml_path)

        try:
            notes_data = _extract_notes_from_musicxml(xml_path)
        except ET.ParseError:
            logger.exception("homr produced malformed MusicXML for %s", file.filename)
            return JSONResponse(status_code=422, content={"error": "HOMR produced invalid MusicXML."})

        if not notes_data:
            return JSONResponse(status_code=422, content={"error": "No notes were detected in the parsed sheet."})

        notes = [item["name"] for item in notes_data]
        frequencies = [item["frequency"] for item in notes_data if item["frequency"] is not None]
        if not frequencies:
            return JSONResponse(status_code=422, content={"error": "No playable pitches were detected in the parsed sheet."})

        xml_data = xml_path.read_text(encoding="utf-8")
        return JSONResponse(
            content={
                "notes": notes,
                "frequencies": frequencies,
                "xmlData": xml_data,
            }
        )
    except subprocess.TimeoutExpired:
        logger.error("homr timed out after %s seconds for %s", HOMR_TIMEOUT_SECONDS, file.filename)
        return JSONResponse(
            status_code=504,
            content={"error": f"HOMR inference timed out after {HOMR_TIMEOUT_SECONDS} seconds."},
        )
    except FileNotFoundError:
        logger.exception("uvx/homr command not found while parsing %s", file.filename)
        return JSONResponse(status_code=502, content={"error": "The HOMR command is not available in this environment."})
    except Exception:  # noqa: BLE001
        logger.exception("Unexpected failure while parsing %s", file.filename)
        return JSONResponse(status_code=500, content={"error": "Failed to parse sheet image."})
    finally:
        for path in created_paths:
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                continue

        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
