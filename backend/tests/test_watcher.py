"""Watcher mode selection (native events where the kernel delivers them,
polling only where it can't) and the boot-time heal scan."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

import app.watcher as watcher
from app.watcher import LibraryWatcher, mount_fstype
from tests.audio_fixtures import make_mp3

MOUNTINFO = "\n".join(
    [
        "22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw",
        "30 22 0:40 / /music rw,relatime - nfs4 nas:/volume1/music rw",
        "31 22 8:17 / /data rw,relatime - btrfs /dev/sdb1 rw",
        r"32 22 0:41 / /mnt/my\040share rw - cifs //nas/share rw",
        "33 22 0:42 / /media rw - fuse.shfs shfs rw",
    ]
)


@pytest.mark.parametrize(
    ("path", "fstype"),
    [
        ("/music/Artist/Album", "nfs4"),
        ("/data/music", "btrfs"),
        ("/srv/music", "ext4"),
        ("/mnt/my share/x", "cifs"),
        ("/media", "fuse.shfs"),
        ("/musicals", "ext4"),  # a prefix by characters, not by path
    ],
)
def test_mount_fstype(path, fstype):
    assert mount_fstype(Path(path), MOUNTINFO) == fstype


@pytest.mark.parametrize(
    ("fstype", "kernel", "mode"),
    [
        ("ext4", "6.8.0-45-generic", "native"),  # Linux host bind mount: inotify works
        ("btrfs", "4.4.302+", "native"),  # a Synology volume
        ("nfs4", "6.8.0", "polling"),
        ("cifs", "6.8.0", "polling"),
        ("fuse.shfs", "6.1.0-unraid", "polling"),
        ("fakeowner", "6.10.14-linuxkit", "polling"),  # Docker Desktop
        ("ext4", "6.10.14-linuxkit", "polling"),
    ],
)
def test_auto_mode_on_linux(monkeypatch, tmp_path, fstype, kernel, mode):
    monkeypatch.setattr(watcher.sys, "platform", "linux")
    monkeypatch.setattr(watcher, "mount_fstype", lambda path: fstype)
    real_read = Path.read_text

    def fake_read(self, *args, **kwargs):
        if str(self) == "/proc/sys/kernel/osrelease":
            return kernel
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fake_read)
    assert watcher.choose_mode(tmp_path)[0] == mode


def test_auto_mode_off_linux_is_native(monkeypatch, tmp_path):
    monkeypatch.setattr(watcher.sys, "platform", "darwin")
    assert watcher.choose_mode(tmp_path)[0] == "native"


def test_poll_interval_default_is_gentle():
    import importlib
    import os

    from app import config

    if "FLOW_POLL_INTERVAL" in os.environ:
        pytest.skip("FLOW_POLL_INTERVAL set in the environment")
    assert importlib.reload(config).POLL_INTERVAL == 60.0


class FakeScanner:
    def __init__(self, heal: bool = False) -> None:
        self.heal = heal
        self.started: list[str] = []

    def take_heal_request(self) -> bool:
        heal, self.heal = self.heal, False
        return heal

    def start_scan(self, trigger: str, full: bool = False) -> bool:
        self.started.append(trigger)
        return True


@pytest.mark.parametrize("mode", ["native", "polling"])
def test_explicit_modes_are_honored(monkeypatch, tmp_path, mode):
    from app import config

    monkeypatch.setattr(config, "WATCHER_MODE", mode)
    w = LibraryWatcher(FakeScanner(), tmp_path)
    w.start()
    try:
        expected = watcher.PollingObserver if mode == "polling" else watcher.Observer
        assert isinstance(w._observer, expected)
    finally:
        w.stop()


def test_native_failure_falls_back_to_polling(monkeypatch, tmp_path):
    from app import config

    class BrokenObserver:
        def schedule(self, *args, **kwargs):
            pass

        def start(self):
            raise OSError(28, "inotify watch limit reached")

    monkeypatch.setattr(config, "WATCHER_MODE", "native")
    monkeypatch.setattr(watcher, "Observer", BrokenObserver)
    w = LibraryWatcher(FakeScanner(), tmp_path)
    w.start()
    try:
        assert isinstance(w._observer, watcher.PollingObserver)
    finally:
        w.stop()


def test_heal_request_starts_one_scan(monkeypatch, tmp_path):
    from app import config

    monkeypatch.setattr(config, "WATCHER_MODE", "polling")
    scanner = FakeScanner(heal=True)
    w = LibraryWatcher(scanner, tmp_path)
    w.start()
    w.stop()
    assert scanner.started == ["heal"]
    w.start()
    w.stop()
    assert scanner.started == ["heal"]


# ---- an unreadable library root never takes the app down ----

needs_posix_perms = pytest.mark.skipif(
    sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0),
    reason="POSIX permissions, and root reads anything",
)


@pytest.fixture
def locked_root(tmp_path):
    root = tmp_path / "locked-music"
    root.mkdir()
    make_mp3(root / "01.mp3", title="T", artist="A")
    yield root
    os.chmod(root, 0o755)


@needs_posix_perms
@pytest.mark.parametrize("mode", ["auto", "native", "polling"])
def test_unreadable_root_pauses_watching_then_recovers(
    monkeypatch, locked_root, mode
):
    from app import config

    monkeypatch.setattr(config, "WATCHER_MODE", mode)
    monkeypatch.setattr(watcher, "RETRY_SECONDS", 0.05)
    os.chmod(locked_root, 0)
    scanner = FakeScanner()
    w = LibraryWatcher(scanner, locked_root)
    try:
        w.start()  # no PermissionError out of the observer's first snapshot
        assert w._observer is None
        os.chmod(locked_root, 0o755)
        deadline = time.monotonic() + 5
        while w._observer is None:
            assert time.monotonic() < deadline, "watching never resumed"
            time.sleep(0.02)
        deadline = time.monotonic() + 5
        while not scanner.started:
            assert time.monotonic() < deadline
            time.sleep(0.02)
        assert scanner.started == ["watch"]  # catch up on what was missed
    finally:
        w.stop()


@needs_posix_perms
def test_scan_of_unreadable_root_keeps_the_index(conn, scanner, music):
    make_mp3(music / "01.mp3", title="Kept", artist="A")
    scanner.run_scan("test")
    os.chmod(music, 0)
    try:
        scanner.run_scan("test")
    finally:
        os.chmod(music, 0o755)
    assert conn.execute("SELECT title FROM tracks").fetchone()["title"] == "Kept"
    state = scanner.current_state_event()
    assert state["mount_guard"] is True and state["state"] == "idle"
    (item,) = scanner.scan_error_log()["items"]
    assert "couldn’t be read" in item["reason"]


@needs_posix_perms
def test_app_starts_with_unreadable_root(monkeypatch, tmp_path, locked_root):
    """The infra repro: the root is unreadable by the runtime user at boot.
    The server must come up healthy with the index untouched."""
    from fastapi.testclient import TestClient

    from app import config
    from app.main import create_app

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "api.db")
    monkeypatch.setattr(config, "MUSIC_DIR", locked_root)
    monkeypatch.setattr(config, "DIST_DIR", None)
    monkeypatch.setattr(config, "WATCHER_MODE", "polling")
    app = create_app()
    app.state.scanner.run_scan("seed")  # an existing index
    app.state.db.close_thread()
    os.chmod(locked_root, 0)
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        app.state.scanner.run_scan("test")
        assert client.get("/api/tracks").json()["total"] == 1
