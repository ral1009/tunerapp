"""Runs HOMR for /api/parse-sheet: a persistent worker process, with the one-shot CLI as fallback.

No FastAPI imports, same convention as matchmaker_service.py. ``parse(image_path, timeout)``
blocks, so callers run it in a thread (main.py uses asyncio.to_thread) -- the old handler called
subprocess.run directly inside an async endpoint, which froze the whole server, including every
open alignment WebSocket, for the 30-60 s HOMR takes.

The worker (homr_worker.py, inside homr's own uv environment) keeps the models loaded and
parses staves in parallel; on an 8-staff phone photo that's ~24 s per upload instead of ~39 s,
with byte-identical output. If the worker can't start or dies, the one-shot command
``uvx --with "opencv-python<5" homr <image>`` is used instead, exactly as before.
"""
from __future__ import annotations

import json
import logging
import subprocess
import threading
from pathlib import Path

logger = logging.getLogger("homr_runner")

WORKER_SCRIPT = Path(__file__).resolve().parent / "homr_worker.py"
# `--with "opencv-python<5"` is load-bearing, not a version preference. homr depends on
# opencv-python-headless (<5) while its rapidocr dependency declares opencv-python with no upper
# bound; both install into the same cv2/ directory and overwrite each other. Once OpenCV 5.0
# shipped, an unpinned rebuild paired a 5.x Python shim with a 4.x binary and homr failed at import
# (AttributeError: module 'cv2' has no attribute 'gapi_wip_gst_GStreamerPipeline').
UVX_HOMR = ["uvx", "--with", "opencv-python<5"]


class HomrError(Exception):
    """HOMR ran but failed; the message is for server logs, not the client."""


class _Worker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._failed_to_start = False

    def _read_reply(self, timeout: float) -> dict:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        result: dict = {}

        def read() -> None:
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("{"):
                    result.update(json.loads(line))
                    return

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        reader.join(timeout)
        if reader.is_alive():
            self._kill()
            raise subprocess.TimeoutExpired(cmd="homr_worker", timeout=timeout)
        if not result:
            self._kill()
            raise HomrError("homr worker exited")
        return result

    def _kill(self) -> None:
        if self._proc is not None:
            try:
                self._proc.kill()
            except OSError:
                pass
        self._proc = None

    def _ensure_started(self) -> bool:
        if self._proc is not None and self._proc.poll() is None:
            return True
        if self._failed_to_start:
            return False
        try:
            self._proc = subprocess.Popen(
                [*UVX_HOMR, "--from", "homr", "python", str(WORKER_SCRIPT)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
            )
            ready = self._read_reply(timeout=300)  # first run may download models
            logger.info("HOMR worker ready (parallel staves: %s)", ready.get("parallel"))
            return True
        except Exception:  # noqa: BLE001
            logger.exception("HOMR worker failed to start; using the one-shot homr command")
            self._failed_to_start = True
            self._kill()
            return False

    def start(self) -> None:
        with self._lock:
            self._ensure_started()

    def parse(self, image_path: Path, timeout: float) -> Path | None:
        """Returns the MusicXML path, or None if the worker isn't available."""
        with self._lock:
            if not self._ensure_started():
                return None
            assert self._proc is not None and self._proc.stdin is not None
            try:
                self._proc.stdin.write(json.dumps({"image": str(image_path)}) + "\n")
                self._proc.stdin.flush()
            except OSError:
                self._kill()
                return None
            reply = self._read_reply(timeout)
            if not reply.get("ok"):
                raise HomrError(reply.get("error", "unknown homr error"))
            logger.info("HOMR worker parsed %s in %.1fs", image_path.name, reply.get("seconds", 0.0))
            return Path(reply["xml"])


_worker = _Worker()


def start_worker() -> None:
    """Start the worker ahead of the first upload (called from server startup, off the event loop)."""
    _worker.start()


def parse(image_path: Path, timeout: float) -> Path:
    """Parse one sheet image into MusicXML next to it. Raises subprocess.TimeoutExpired,
    FileNotFoundError (uvx missing) or HomrError."""
    xml = _worker.parse(image_path, timeout)
    if xml is not None:
        return xml
    result = subprocess.run([*UVX_HOMR, "homr", str(image_path)], capture_output=True, timeout=timeout, text=True)
    if result.returncode != 0:
        raise HomrError(f"homr exited with code {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}")
    candidates = sorted(image_path.parent.glob("*.musicxml"))
    if not candidates:
        raise HomrError(f"homr produced no .musicxml output\nstdout: {result.stdout}\nstderr: {result.stderr}")
    return candidates[0]
