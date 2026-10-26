"""Startup heal (run_startup_heal) and the manual `python -m app.heal`."""

from __future__ import annotations

import shutil
import subprocess
import unicodedata

import pytest

from app.scanner import DETECT_VERSION_KEY, HEAL_RESCAN_KEY
from tests.audio_fixtures import make_mp3


def setting(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


@pytest.fixture
def auto_heal(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "AUTO_HEAL", True)


def test_fresh_install_needs_no_heal(db, conn, auto_heal):
    from app.heal import run_startup_heal

    run_startup_heal(db)
    assert setting(conn, HEAL_RESCAN_KEY) is None


def test_scanned_library_is_not_healed_again(db, conn, music, scanner, auto_heal):
    from app.heal import run_startup_heal

    make_mp3(music / "01.mp3", title="T")
    scanner.run_scan("test")  # writes the current detection version
    run_startup_heal(db)
    assert setting(conn, HEAL_RESCAN_KEY) is None


def test_library_from_an_older_release_gets_one_boot_scan(
    db, conn, music, scanner, auto_heal
):
    from app.heal import run_startup_heal

    make_mp3(music / "01.mp3", title="T")
    scanner.run_scan("test")
    conn.execute("DELETE FROM settings WHERE key = ?", (DETECT_VERSION_KEY,))
    conn.commit()

    run_startup_heal(db)
    run_startup_heal(db)  # idempotent
    assert setting(conn, HEAL_RESCAN_KEY) == "1"
    assert scanner.take_heal_request() is True
    assert scanner.take_heal_request() is False  # consumed once


def test_auto_heal_off_skips_the_boot_scan(db, conn, music, scanner, monkeypatch):
    from app import config
    from app.heal import run_startup_heal

    monkeypatch.setattr(config, "AUTO_HEAL", False)
    make_mp3(music / "01.mp3", title="T")
    scanner.run_scan("test")
    conn.execute("DELETE FROM settings WHERE key = ?", (DETECT_VERSION_KEY,))
    conn.commit()
    run_startup_heal(db)
    assert setting(conn, HEAL_RESCAN_KEY) is None


def test_startup_heal_backfills_lookup_keys(db, conn, auto_heal):
    from app.heal import run_startup_heal

    nfd = unicodedata.normalize("NFD", "Beyoncé")
    conn.execute("INSERT INTO artists (name) VALUES (?)", (nfd,))
    conn.commit()
    run_startup_heal(db)
    key = conn.execute("SELECT name_key FROM artists").fetchone()["name_key"]
    assert key == "beyoncé"


def test_startup_heal_never_raises(monkeypatch, db):
    import app.heal as heal

    def boom(conn):
        raise RuntimeError("broken")

    monkeypatch.setattr(heal, "backfill_name_keys", boom)
    heal.run_startup_heal(db)  # logged, not raised


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg must be on PATH")
def test_manual_heal_marks_misindexed_rows(db, conn, music, scanner, monkeypatch, capsys):
    """`python -m app.heal` still works: rows whose bytes contradict their
    format get mtime 0 (the next scan reprocesses them)."""
    from app import config, heal

    make_mp3(music / "ok.mp3", title="Fine")
    subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1",
         "-c:a", "pcm_s16le", "-f", "wav", "-y", str(music / "wave.mp3")],
        check=True, capture_output=True,
    )
    scanner.run_scan("test")
    conn.execute("UPDATE tracks SET format = 'mp3' WHERE path = 'wave.mp3'")  # v1.5.0
    conn.commit()

    monkeypatch.setattr(config, "DB_PATH", db.path)
    monkeypatch.setattr(config, "MUSIC_DIR", music)
    heal.main()
    out = capsys.readouterr().out
    assert "marked: wave.mp3" in out
    assert "1 of 2 rows" in out
    mtimes = {r["path"]: r["mtime"] for r in conn.execute("SELECT path, mtime FROM tracks")}
    assert mtimes["wave.mp3"] == 0
    assert mtimes["ok.mp3"] > 0

    scanner.run_scan("test")
    row = conn.execute("SELECT format, mtime FROM tracks WHERE path = 'wave.mp3'").fetchone()
    assert row["format"] == "wav" and row["mtime"] > 0
