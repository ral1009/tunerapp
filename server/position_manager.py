"""Bridges score-following positions from a worker thread to an asyncio WebSocket handler.

Matchmaker's generator is synchronous and runs on its own thread, so positions can't be awaited
directly. Each session gets one slot plus one ``asyncio.Event``; the worker writes the slot and
wakes the event via ``loop.call_soon_threadsafe``, and the handler reads whatever is in the slot.

The slot is last-value-wins rather than a queue, deliberately: alignment updates are absolute
positions, not increments, so if several land while the socket is busy, only the newest is worth
sending. A queue would instead build a backlog of stale positions and walk the cursor through
history.
"""

from __future__ import annotations

import asyncio
import math
import threading


class PositionManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._positions: dict[str, tuple[float, float]] = {}
        self._subscribers: dict[str, list[tuple[asyncio.AbstractEventLoop, asyncio.Event]]] = {}

    def subscribe(self, session_id: str) -> asyncio.Event:
        loop = asyncio.get_running_loop()
        event = asyncio.Event()
        with self._lock:
            self._subscribers.setdefault(session_id, []).append((loop, event))
        return event

    def unsubscribe(self, session_id: str, event: asyncio.Event) -> None:
        with self._lock:
            remaining = [entry for entry in self._subscribers.get(session_id, []) if entry[1] is not event]
            if remaining:
                self._subscribers[session_id] = remaining
            else:
                self._subscribers.pop(session_id, None)
            self._positions.pop(session_id, None)

    def set_position(self, session_id: str, quarter: float, beat: float) -> None:
        """Called from the worker thread."""
        if math.isnan(quarter) or math.isinf(quarter):
            return
        with self._lock:
            self._positions[session_id] = (quarter, beat)
            subscribers = list(self._subscribers.get(session_id, []))
        # Notified outside the lock: call_soon_threadsafe touches another loop's internals, and
        # holding our lock across that invites a deadlock against a handler calling in here.
        self._notify(subscribers)

    def get_position(self, session_id: str) -> tuple[float, float] | None:
        with self._lock:
            return self._positions.get(session_id)

    def wake(self, session_id: str) -> None:
        """Wake subscribers without writing a position -- used to signal that a session ended."""
        with self._lock:
            subscribers = list(self._subscribers.get(session_id, []))
        self._notify(subscribers)

    @staticmethod
    def _notify(subscribers: list[tuple[asyncio.AbstractEventLoop, asyncio.Event]]) -> None:
        for loop, event in subscribers:
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:
                # Loop already closed; its handler is gone and unsubscribe will clean up.
                pass


position_manager = PositionManager()
