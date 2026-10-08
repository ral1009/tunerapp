from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketDisconnect, WebSocketState
import xml.etree.ElementTree as ET

import homr_runner
from position_manager import position_manager

BASE_DIR = Path(__file__).resolve().parent
TMP_ROOT = BASE_DIR / "tmp"
TMP_ROOT.mkdir(parents=True, exist_ok=True)

# 120 s: a long page can legitimately take over a minute on CPU.
HOMR_TIMEOUT_SECONDS = int(os.environ.get("HOMR_TIMEOUT_SECONDS", "120"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("homr_sheet_parser")

# Used for score preparation only (LiveAligner construction: fluidsynth + feature extraction).
# The long-running alignment loop deliberately does NOT go through this pool -- a session lasts
# as long as the user plays, and one stuck or slow session in a small shared pool previously
# blocked every subsequent session's preparation, which the browser saw as "preparing score"
# forever. Sessions run on the loop's default executor instead, which is sized for many
# concurrent blocking tasks.
alignment_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="align-prep")

app = FastAPI(title="HOMR Sheet Parser")
app.add_middleware(
    CORSMiddleware,
    # Normal browser traffic goes through Vite's dev-server proxy (see vite.config.ts) as a
    # same-origin request, which needs no CORS allowance at all. This allowlist only matters for
    # direct requests to this server (e.g. curl, or a client that bypasses the proxy) -- kept
    # permissive across localhost/127.0.0.1/any private-LAN IP on Vite's dev port since this
    # server is local-dev-only, not deployed. Also the native app's web build (Expo on :8081, plain
    # http); the native iOS/Android app itself sends no Origin and needs no allowance.
    allow_origin_regex=r"(https://(localhost|127\.0\.0\.1|(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.[\d.]+):5173)|(http://(localhost|127\.0\.0\.1|(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.[\d.]+):8081)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _warm_up_alignment() -> None:
    # The first practice session otherwise pays ~10-20 s of one-time costs while showing "preparing
    # the score" (see matchmaker_service.warm_up). Background thread so the server starts accepting
    # requests immediately; a failed import is fine, the WebSocket handler reports it per session.
    def run() -> None:
        try:
            import matchmaker_service

            matchmaker_service.warm_up()
        except Exception:  # noqa: BLE001
            logger.info("Alignment warm-up skipped (alignment dependencies unavailable)")

    threading.Thread(target=run, name="align-warmup", daemon=True).start()
    # Same idea for HOMR: load its models before the first photo upload, not during it.
    threading.Thread(target=homr_runner.start_worker, name="homr-warmup", daemon=True).start()


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

        # Off the event loop: HOMR takes tens of seconds, and calling it inline froze the whole
        # server -- every open alignment WebSocket included -- until it finished.
        try:
            xml_path = await asyncio.to_thread(homr_runner.parse, uploaded_path, HOMR_TIMEOUT_SECONDS)
        except homr_runner.HomrError as error:
            logger.error("homr failed for %s: %s", file.filename, error)
            return JSONResponse(status_code=502, content={"error": "HOMR failed to parse the sheet image."})
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


@app.websocket("/ws/align")
async def align(websocket: WebSocket) -> None:
    """Real-time score following: browser PCM in, quarter-note score positions out.

    Protocol:
      client -> {"type": "config", "scoreHash": str, "scoreXml": str?, "sampleRate": int}
      server -> {"status": "need_score"}              (hash unknown here; resend config with XML)
      server -> {"status": "ready", "hopLength": int, "totalQuarters": float}
      client -> binary float32 PCM, exactly hopLength samples per frame
      server -> {"status": "stream_started"}
      server -> {"quarter": float, "beat": float, "serverTs": float}   (only when it changes)
      server -> {"status": "completed"} | {"status": "error", "message": str}

    hopLength is dictated by the server rather than assumed by the client, so the frame-rate
    convention lives in one place (matchmaker_service.FRAME_RATE).
    """
    await websocket.accept()
    session_id = str(uuid.uuid4())

    # Imported here, not at module scope: it pulls in matchmaker/partitura/librosa (seconds of
    # import time), and /api/parse-sheet must keep working in an environment where the alignment
    # dependencies were never installed.
    try:
        import matchmaker_service
    except Exception:  # noqa: BLE001
        logger.exception("Alignment dependencies are unavailable")
        await websocket.send_json({"status": "error", "message": "Alignment dependencies are not installed on the server."})
        await websocket.close()
        return

    aligner = None
    position_event = None
    receive_task: asyncio.Task | None = None
    send_task: asyncio.Task | None = None

    try:
        config = await websocket.receive_json()
        score_hash = config.get("scoreHash")
        score_xml = config.get("scoreXml")
        sample_rate = int(config.get("sampleRate") or 48000)

        score_path = matchmaker_service.has_cached_score(score_hash) if score_hash else None
        if score_path is None:
            if not score_xml:
                await websocket.send_json({"status": "need_score"})
                config = await websocket.receive_json()
                score_xml = config.get("scoreXml")
            if not score_xml:
                await websocket.send_json({"status": "error", "message": "No score was provided."})
                return
            score_hash, score_path = matchmaker_service.write_score(score_xml)

        loop = asyncio.get_running_loop()
        # Construction synthesizes the score with fluidsynth and extracts its reference features --
        # seconds of CPU work, so it must not block the event loop.
        aligner = await loop.run_in_executor(
            alignment_executor, matchmaker_service.LiveAligner, score_path, score_hash, sample_rate
        )

        await websocket.send_json(
            {"status": "ready", "hopLength": aligner.hop_length, "totalQuarters": aligner.total_quarters}
        )

        position_event = position_manager.subscribe(session_id)

        def on_position(quarter: float, beat: float) -> None:
            position_manager.set_position(session_id, quarter, beat)

        # Started on the FIRST audio chunk, not at ready: the browser deliberately withholds audio
        # until the player actually makes a sound (see audio/matchmakerStream.ts), and Matchmaker's
        # stream gives up if its queue stays empty for QUEUE_TIMEOUT (10s) after the run begins.
        # Starting here means that clock only begins once audio is genuinely flowing.
        run_future: asyncio.Future | None = None

        def start_alignment() -> asyncio.Future:
            future = loop.run_in_executor(None, aligner.run, on_position)
            # A finished (or crashed) alignment thread must wake the sender, or it waits on an
            # event that nothing will ever set again.
            future.add_done_callback(lambda _f: position_manager.wake(session_id))
            return future

        async def receive_audio() -> None:
            nonlocal run_future
            chunks = 0
            try:
                while websocket.client_state == WebSocketState.CONNECTED:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        break
                    payload = message.get("bytes")
                    if payload:
                        if run_future is None:
                            run_future = start_alignment()
                        aligner.push_chunk(bytes(payload))
                        chunks += 1
                        if chunks == 1:
                            await websocket.send_json({"status": "stream_started"})
                        elif chunks % 15 == 0:
                            # ~2x/second: lets the page show that frames are being ignored as
                            # "not the piece", which otherwise looks identical to a stall.
                            accepted, rejected = aligner.frame_stats()
                            await websocket.send_json({"framesAccepted": accepted, "framesRejected": rejected})
                        continue
                    text = message.get("text")
                    if text:
                        try:
                            control = json.loads(text)
                        except ValueError:
                            control = {}
                        if control.get("type") == "seek" and isinstance(control.get("quarter"), (int, float)):
                            # The player jumped ("Jump to bar"): move the live follower and
                            # remember where, for the post-take alignment.
                            aligner.seek(float(control["quarter"]))
                            continue
                        if control.get("type") == "stop" or '"stop"' in text:
                            break
            except WebSocketDisconnect:
                pass
            finally:
                logger.info("Alignment session %s received %s chunks", session_id[:8], chunks)
                aligner.stop()

        async def send_positions() -> None:
            previous: tuple[float, float] | None = None
            while websocket.client_state == WebSocketState.CONNECTED:
                await position_event.wait()
                position_event.clear()

                current = position_manager.get_position(session_id)
                if current is not None and current != previous:
                    previous = current
                    quarter, beat = current
                    await websocket.send_json({"quarter": quarter, "beat": beat, "serverTs": time.time() * 1000})

                if run_future is not None and run_future.done():
                    return

        receive_task = asyncio.create_task(receive_audio())
        send_task = asyncio.create_task(send_positions())
        _, pending = await asyncio.wait([receive_task, send_task], return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # The take is over -- either the browser asked to finish, or the piece ran out. Both need
        # the same ending: report how the live run went, then the offline alignment, then close.
        # (A dropped connection has nobody to send to, and skips all of this.)
        if websocket.client_state == WebSocketState.CONNECTED:
            aligner.stop()
            failure: BaseException | None = None
            if run_future is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(run_future), timeout=5)
                except asyncio.TimeoutError:
                    logger.warning("Alignment session %s: live thread slow to stop", session_id[:8])
                except Exception as exc:  # noqa: BLE001
                    failure = exc
            if failure is not None:
                # A crash on the alignment thread otherwise looks exactly like the piece
                # finishing, both here and in the browser -- surface it as what it is.
                logger.error("Alignment session %s crashed", session_id[:8], exc_info=failure)
                await websocket.send_json({"status": "error", "message": f"Alignment failed: {failure}"})
            else:
                await websocket.send_json({"status": "completed"})

            # Still attempted after a live crash: the recording is intact either way, and the
            # offline pass doesn't depend on the live thread having finished cleanly.
            try:
                points = await loop.run_in_executor(alignment_executor, aligner.compute_offline_alignment)
            except Exception:  # noqa: BLE001
                logger.exception("Alignment session %s: offline alignment failed", session_id[:8])
                points = []
            if points and websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json(
                    {"type": "offlineAlignment", "path": [[t, q] for t, q in points]}
                )
    except WebSocketDisconnect:
        logger.info("Alignment session %s disconnected", session_id[:8])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Alignment session %s failed", session_id[:8])
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.send_json({"status": "error", "message": str(exc)})
    finally:
        if aligner is not None:
            # Without the sentinel this pushes, the worker thread stays parked in queue.get()
            # forever -- one leaked thread per session.
            aligner.stop()
        if position_event is not None:
            position_manager.unsubscribe(session_id, position_event)
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                await websocket.close()
            except RuntimeError:
                pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
