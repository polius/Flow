"""In-process event bus for scan progress (SSE, DESIGN.md §6).

Single-worker deployment: the scanner thread publishes state events,
the SSE endpoint subscribes per client. No cross-process fan-out needed.
"""

from __future__ import annotations

import queue
import threading


class ScanBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: set[queue.Queue[dict]] = set()

    def subscribe(self) -> queue.Queue[dict]:
        q: queue.Queue[dict] = queue.Queue(maxsize=1000)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue[dict]) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, event: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:  # slow client: drop rather than block the scanner
                pass
