"""In-process event bus for scan progress (single worker; no cross-process fan-out).

The scanner publishes from its own thread; each SSE stream is an asyncio
consumer on the event loop. Events are whole state snapshots, so a
subscriber only ever needs the newest one: delivery overwrites whatever the
stream hasn't sent yet, and a slow client can never back up the scanner or
hold memory.
"""

from __future__ import annotations

import asyncio
import threading


class Subscription:
    """One SSE stream's mailbox: an asyncio.Queue of size one that always
    holds the latest event. Lives on the event loop that created it."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=1)

    def _deliver(self, event: dict) -> None:
        # Runs on the loop thread (call_soon_threadsafe): drop the stale
        # snapshot, keep the new one.
        if self._queue.full():
            self._queue.get_nowait()
        self._queue.put_nowait(event)

    async def get(self, timeout: float) -> dict | None:
        """The next event, or None after `timeout` seconds of quiet."""
        try:
            return await asyncio.wait_for(self._queue.get(), timeout)
        except TimeoutError:
            return None


class ScanBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: set[Subscription] = set()

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> Subscription:
        sub = Subscription(loop)
        with self._lock:
            self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            self._subs.discard(sub)

    def publish(self, event: dict) -> None:
        """Thread-safe; never blocks the publisher."""
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            try:
                sub.loop.call_soon_threadsafe(sub._deliver, event)
            except RuntimeError:  # loop closed (shutdown): nobody to tell
                self.unsubscribe(sub)
