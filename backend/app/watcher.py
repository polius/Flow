"""Filesystem watcher: watchdog events → debounced reconcile scans."""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path

from watchdog.events import (
    EVENT_TYPE_CLOSED_NO_WRITE,
    EVENT_TYPE_OPENED,
    FileSystemEvent,
    FileSystemEventHandler,
)
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from app import config
from app.scanner import LibraryScanner

log = logging.getLogger("flow.watcher")

# A debounce window ends in a full *reconcile* scan, not a targeted reindex:
# at the target scale an mtime-skip reconcile is fast, and reusing the manual
# scan's exact overlay/move/removal semantics keeps one code path.

# Filesystems whose changes never reach inotify inside the container: network
# shares (a change made by another machine), and the VM file sharing of
# Docker Desktop (macOS/Windows hosts). Everything else — ext4, xfs, btrfs,
# zfs bind mounts on a Linux host, NAS volumes included — delivers native
# events, so the library isn't stat'ed every few seconds and disks can sleep.
_EVENTLESS_FS = frozenset({
    "nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "virtiofs", "fakeowner",
    "grpcfuse", "vboxsf", "prl_fs", "osxfs", "afpfs", "davfs", "ncpfs",
})


class _DebouncingHandler(FileSystemEventHandler):
    def __init__(self, schedule: "callable") -> None:  # noqa: UP037
        super().__init__()
        self._schedule = schedule

    def on_any_event(self, event: FileSystemEvent) -> None:
        # Reads change nothing. inotify reports them (watchdog ≥ 2.3), and
        # Flow reads the library itself — the loudness pass's ffmpeg, the
        # stream endpoint, a full rescan's tag reads — so treating a read
        # as a change rescans in a loop (a track ffmpeg can't measure is
        # re-opened by every pass, forever).
        if event.event_type in (EVENT_TYPE_OPENED, EVENT_TYPE_CLOSED_NO_WRITE):
            return
        for path in (event.src_path, getattr(event, "dest_path", None)):
            if not path:
                continue
            name = os.path.basename(path)
            # Hidden noise (.DS_Store, ._ AppleDouble) is never relevant.
            if name.startswith("."):
                return
        self._schedule()


def _unescape_mount(path: str) -> str:
    """/proc/self/mountinfo escapes space, tab, newline and backslash as
    octal (\\040 …)."""
    out, i = [], 0
    while i < len(path):
        if path[i] == "\\" and i + 3 < len(path) and path[i + 1 : i + 4].isdigit():
            out.append(chr(int(path[i + 1 : i + 4], 8)))
            i += 4
        else:
            out.append(path[i])
            i += 1
    return "".join(out)


def mount_fstype(path: Path, mountinfo: str | None = None) -> str | None:
    """Filesystem type of the mount holding `path` (Linux only): the
    longest mount point that prefixes it, per /proc/self/mountinfo."""
    if mountinfo is None:
        try:
            mountinfo = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
        except OSError:
            return None
    target = os.path.realpath(path)
    best, best_type = "", None
    for line in mountinfo.splitlines():
        head, sep, tail = line.partition(" - ")
        fields = head.split()
        if not sep or len(fields) < 5 or not tail.split():
            continue
        point = _unescape_mount(fields[4])
        inside = target == point or target.startswith(point.rstrip("/") + "/")
        if inside and len(point) >= len(best):
            best, best_type = point, tail.split()[0]
    return best_type


def choose_mode(music_dir: Path) -> tuple[str, str]:
    """(mode, reason) for FLOW_WATCHER=auto: native events wherever the
    kernel actually delivers them, polling only where it can't."""
    if not sys.platform.startswith("linux"):
        return "native", sys.platform
    try:
        kernel = Path("/proc/sys/kernel/osrelease").read_text(encoding="utf-8").lower()
    except OSError:
        kernel = ""
    if "linuxkit" in kernel:
        return "polling", "Docker Desktop VM (host changes don't reach inotify)"
    fstype = mount_fstype(music_dir)
    if fstype and (fstype in _EVENTLESS_FS or fstype.startswith("fuse")):
        return "polling", f"{fstype} filesystem"
    return "native", f"{fstype or 'local'} filesystem"


# How often a missing or unreadable library folder is re-checked before
# watching starts (a share mounted late, ownership fixed after boot).
RETRY_SECONDS = 30.0


def _unusable_reason(music_dir: Path) -> str | None:
    """Why the library folder can't be watched right now, or None."""
    if not music_dir.is_dir():
        return "does not exist"
    try:
        with os.scandir(music_dir) as it:
            next(it, None)
    except OSError as exc:
        return f"can't be read ({exc.strerror or exc})"
    return None


class LibraryWatcher:
    def __init__(self, scanner: LibraryScanner, music_dir: Path) -> None:
        self._scanner = scanner
        self._music = music_dir
        self._observer = None
        self._timer: threading.Timer | None = None
        self._retry: threading.Timer | None = None
        self._stopped = False
        self._lock = threading.Lock()

    def start(self) -> None:
        # The startup heal found rows indexed under older detection rules:
        # one rescan now re-checks them (a scan copes with an unreadable
        # library on its own — the mount guard keeps the index untouched).
        if self._scanner.take_heal_request():
            self._scanner.start_scan(trigger="heal")
        if not self._try_start():
            self._schedule_retry()

    def _try_start(self) -> bool:
        """Start observing. False when the library folder is missing or
        unreadable right now — never an exception: a folder the runtime
        user can't read (wrong owner, chmod 700, a share not mounted yet)
        must not keep the server from starting."""
        unusable = _unusable_reason(self._music)
        if unusable:
            log.warning(
                "Library folder %s %s — filesystem watching paused; Flow keeps "
                "serving the existing index and retries every %g s",
                self._music, unusable, RETRY_SECONDS,
            )
            return False

        mode = config.WATCHER_MODE
        reason = f"FLOW_WATCHER={mode}"
        if mode not in ("native", "polling"):
            mode, reason = choose_mode(self._music)

        handler = _DebouncingHandler(self._schedule_reconcile)
        observer = None
        if mode == "native":
            try:
                observer = Observer()
                observer.schedule(handler, str(self._music), recursive=True)
                observer.start()
            except OSError as exc:
                # inotify watch/instance limits on huge libraries: polling
                # still works, just less promptly.
                log.warning(
                    "Native file watching unavailable (%s) — falling back to polling", exc
                )
                observer = None
                mode, reason = "polling", "native watcher failed"
        if mode == "polling":
            try:
                observer = PollingObserver(timeout=config.POLL_INTERVAL)
                observer.schedule(handler, str(self._music), recursive=True)
                observer.start()
            except OSError as exc:
                log.warning("Filesystem watching unavailable for %s (%s)", self._music, exc)
                return False
        with self._lock:
            if self._stopped:
                observer.stop()
                return True
            self._observer = observer
        log.info(
            "Watching %s (mode=%s: %s%s)",
            self._music, mode, reason,
            f", every {config.POLL_INTERVAL:g} s" if mode == "polling" else "",
        )
        return True

    def _schedule_retry(self) -> None:
        with self._lock:
            if self._stopped:
                return
            self._retry = threading.Timer(RETRY_SECONDS, self._retry_start)
            self._retry.daemon = True
            self._retry.start()

    def _retry_start(self) -> None:
        if self._try_start():
            # Whatever changed while the folder was unreadable is unseen.
            log.info("Library folder %s is readable again — rescanning", self._music)
            self._scanner.start_scan(trigger="watch")
        else:
            self._schedule_retry()

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            if self._retry is not None:
                self._retry.cancel()
                self._retry = None
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
        # A scan already running queues this as its follow-up: its walk
        # happened at its start and can't have seen the triggering change.
        self._scanner.start_scan(trigger="watch")
