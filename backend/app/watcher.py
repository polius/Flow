"""Filesystem watcher: watchdog events → debounced reconcile scans."""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from app import config
from app.scanner import LibraryScanner

log = logging.getLogger("flow.watcher")

# A debounce window ends in a full *reconcile* scan, not a targeted reindex:
# at the target scale an mtime-skip reconcile is fast, and reusing the manual
# scan's exact overlay/move/removal semantics keeps one code path.


class _DebouncingHandler(FileSystemEventHandler):
    def __init__(self, schedule: "callable") -> None:  # noqa: UP037
        super().__init__()
        self._schedule = schedule

    def on_any_event(self, event: FileSystemEvent) -> None:
        for path in (event.src_path, getattr(event, "dest_path", None)):
            if not path:
                continue
            name = os.path.basename(path)
            # Hidden noise (.DS_Store, ._ AppleDouble) is never relevant.
            if name.startswith("."):
                return
        self._schedule()


class LibraryWatcher:
    def __init__(self, scanner: LibraryScanner, music_dir: Path) -> None:
        self._scanner = scanner
        self._music = music_dir
        self._observer = None
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        mode = config.WATCHER_MODE
        if mode == "auto":
            mode = "polling" if Path("/.dockerenv").exists() else "native"

        if not self._music.is_dir():
            # Manual rescans still work; mounting the folder later requires a
            # container restart to pick up watching.
            log.warning(
                "Library folder %s does not exist — filesystem watching disabled",
                self._music,
            )
            return

        if mode == "polling":
            self._observer = PollingObserver(timeout=config.POLL_INTERVAL)
        else:
            self._observer = Observer()

        self._observer.schedule(
            _DebouncingHandler(self._schedule_reconcile),
            str(self._music),
            recursive=True,
        )
        self._observer.start()
        log.info("Watching %s (mode=%s)", self._music, mode)

    def stop(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=3)
            self._observer = None

    def _schedule_reconcile(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(
                config.WATCH_DEBOUNCE, self._fire
            )
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        if not self._scanner.start_scan(trigger="watch"):
            # A scan is already running; it walked the current state, so the
            # triggering change is covered. Anything newer re-debounces.
            log.debug("Watch reconcile skipped — scan already running")
