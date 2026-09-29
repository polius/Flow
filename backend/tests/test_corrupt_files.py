"""Edge-case tags and corrupt files (DESIGN.md §11.6): the scan must skip +
log bad files and never crash. Also pins the §14.1 broken-mount guard: a
library that contains corrupt files is NOT an empty walk, so removals and
additions must proceed normally around them."""

from __future__ import annotations

import os
import stat
import sys
import time

import pytest
from tests.audio_fixtures import jpeg_bytes, make_flac, make_mp3

from app.scanner import _utcnow


@pytest.fixture
def library(music):
    # Files must exist before the `client` fixture's synchronous scan runs.
    (music / "junk.mp3").write_bytes(b"garbage bytes")
    make_mp3(music / "real.mp3", title="Real", artist="R")
    return music


def track_row(conn, rel: str):
    return conn.execute("SELECT * FROM tracks WHERE path = ?", (rel,)).fetchone()


def count(conn) -> int:
    return conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"]


def set_mtime(path, epoch: float) -> None:
    os.utime(path, (epoch, epoch))


# ---- zero-byte / garbage / truncated files ---------------------------------


def test_zero_byte_files_skipped(conn, music, scanner):
    for name in ("a.mp3", "b.flac", "c.m4a", "d.ogg"):
        (music / name).write_bytes(b"")
    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")

    assert count(conn) == 1
    assert track_row(conn, "good.mp3") is not None
    state = scanner.current_state_event()
    assert state["state"] == "idle"
    assert state["errors"] == 4


def test_garbage_bytes_with_audio_extension_skipped(conn, music, scanner):
    (music / "text.mp3").write_bytes(b"this is not audio, it is a text file")
    (music / "text.flac").write_bytes(b"nope" * 100)
    (music / "text.m4a").write_bytes(b"\x00" * 64)
    (music / "text.ogg").write_bytes(b"OggS-but-actually-not" + b"\x00" * 32)
    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")

    assert count(conn) == 1
    assert scanner.current_state_event()["errors"] == 4


def test_truncated_files_never_crash(conn, music, scanner):
    make_mp3(music / "cut.mp3", title="Cut", artist="C", seconds=5.0)
    data = (music / "cut.mp3").read_bytes()
    (music / "cut.mp3").write_bytes(data[: len(data) // 3])

    make_flac(music / "cut.flac", title="Cut Flac", seconds=5.0)
    fdata = (music / "cut.flac").read_bytes()
    (music / "cut.flac").write_bytes(fdata[:8])  # fLaC magic + partial header

    (music / "m4a.m4a").write_bytes(b"\x00\x00\x00\x18ftypM4A mp42" + b"\x00" * 10)

    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")

    # Whatever mutagen decides (skip or a degraded-but-parsed row), the scan
    # must finish idle with the good file indexed.
    state = scanner.current_state_event()
    assert state["state"] == "idle"
    assert track_row(conn, "good.mp3") is not None


def test_id3_header_without_audio_skipped(conn, music, scanner):
    # A plausible-looking ID3v2 header followed by junk: no MPEG sync anywhere.
    (music / "fake.mp3").write_bytes(b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff" * 512)
    scanner.run_scan("test")
    assert count(conn) == 0
    assert scanner.current_state_event()["state"] == "idle"


def test_wrong_extension_content_skipped(conn, music, scanner):
    # An image pretending to be audio: mutagen sniffs bytes, not names.
    (music / "cover.mp3").write_bytes(jpeg_bytes())
    (music / "cover.flac").write_bytes(jpeg_bytes())
    scanner.run_scan("test")
    assert count(conn) == 0
    assert scanner.current_state_event()["state"] == "idle"


# ---- unreadable files --------------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission model")
@pytest.mark.skipif(os.geteuid() == 0, reason="root reads anything")
def test_unreadable_file_skipped(conn, music, scanner):
    (music / "locked.mp3").write_bytes(b"ID3 secret")
    os.chmod(music / "locked.mp3", 0)
    make_mp3(music / "good.mp3", title="Good", artist="G")
    try:
        scanner.run_scan("test")
        assert count(conn) == 1
        assert track_row(conn, "locked.mp3") is None
        assert scanner.current_state_event()["errors"] == 1
    finally:
        os.chmod(music / "locked.mp3", 0o644)  # let tmp_path clean up


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission model")
@pytest.mark.skipif(os.geteuid() == 0, reason="root reads anything")
def test_unreadable_sidecar_cover_does_not_crash(conn, music, scanner):
    # Parseable audio whose folder fallback cover cannot be read (§13.3).
    make_mp3(music / "01.mp3", title="No Art Path", artist="N", album="Locked")
    (music / "cover.jpg").write_bytes(jpeg_bytes())
    os.chmod(music / "cover.jpg", 0)
    try:
        scanner.run_scan("test")
        row = track_row(conn, "01.mp3")
        assert row is not None
        assert row["artwork_id"] is None
        assert scanner.current_state_event()["state"] == "idle"
    finally:
        os.chmod(music / "cover.jpg", 0o644)


def test_broken_symlink_skipped(conn, music, scanner):
    os.symlink(music / "does-not-exist.mp3", music / "ghost.mp3")
    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")
    assert count(conn) == 1
    assert track_row(conn, "ghost.mp3") is None


# ---- garbage tag values and encodings ---------------------------------------


def test_garbage_tag_values_normalized(conn, music, scanner):
    # Number-free filename: the §4 filename fallback must not mask the
    # garbage TRCK/TYER frames under test. ("3/10" slash forms are legal
    # and parse; pure garbage must yield nulls.)
    make_mp3(
        music / "Weird.mp3",
        title="🎵\u0000 日本語 \n\t rtl",
        artist="  ",
        album="",
        track="abc",
        disc="zzz",
        year="banana",
    )
    scanner.run_scan("test")

    row = track_row(conn, "Weird.mp3")
    assert row is not None  # audio parses; only the tags are garbage
    assert row["track_no"] is None
    assert row["disc_no"] is None
    assert row["year"] is None
    # Whitespace-only / empty tags fall back like missing tags (§4).
    assert row["title"].startswith("🎵")
    assert row["artist_id"] is None or row["artist_id"] > 0  # no crash either way


def test_track_number_zero_normalizes_to_null(conn, music, scanner):
    make_mp3(music / "zero.mp3", title="Zero", track="0", disc="0/2")
    scanner.run_scan("test")
    row = track_row(conn, "zero.mp3")
    assert row["track_no"] is None
    assert row["disc_no"] is None


def test_empty_tag_falls_back_to_filename(conn, music, scanner):
    make_mp3(music / "05 - Fallback.mp3", title="", artist="", album="")
    scanner.run_scan("test")
    row = track_row(conn, "05 - Fallback.mp3")
    assert row["title"] == "Fallback"
    assert row["track_no"] == 5


def test_huge_tag_value_no_crash(conn, music, scanner):
    make_mp3(music / "big.mp3", title="x" * 100_000, artist="B")
    scanner.run_scan("test")
    row = track_row(conn, "big.mp3")
    assert row is not None
    assert len(row["title"]) == 100_000


def test_weird_tags_on_flac(conn, music, scanner):
    make_flac(music / "weird.flac", title="é—文", artist="\u0000null-ish", album="")
    scanner.run_scan("test")
    row = track_row(conn, "weird.flac")
    assert row is not None
    assert row["format"] == "flac"


def test_latin1_encoded_id3_frame(conn, music, scanner):
    # encoding=0 frames carry latin-1 bytes; high bytes must decode, not crash.
    from mutagen.id3 import ID3, TIT2

    path = make_mp3(music / "l1.mp3", title="Base")
    tags = ID3()
    tags.add(TIT2(encoding=0, text="ÿþ naïve café"))
    tags.save(str(path), v2_version=3)
    scanner.run_scan("test")
    row = track_row(conn, "l1.mp3")
    assert row is not None
    assert "naïve café" in row["title"]


# ---- scan bookkeeping around bad files --------------------------------------


def test_all_files_corrupt_still_completes_and_does_not_trip_mount_guard(
    conn, music, scanner
):
    """Every file fails to parse: errors counted, idle state, empty index —
    and crucially NOT the §14.1 broken-mount error state (files were seen)."""
    (music / "bad1.mp3").write_bytes(b"junk")
    (music / "bad2.flac").write_bytes(b"")
    scanner.run_scan("test")

    state = scanner.current_state_event()
    assert state["state"] == "idle"
    assert state["errors"] == 2
    assert count(conn) == 0
    persisted = {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM settings")
    }
    assert persisted["scan_errors"] == "2"


def test_corrupt_files_do_not_block_removals(conn, music, scanner):
    """§14.1 regression pin: with corrupt files present the walk is non-empty,
    so the mount guard must stay silent and normal removals must proceed."""
    make_mp3(music / "keep.mp3", title="Keep", artist="K")
    make_mp3(music / "gone.mp3", title="Gone", artist="G")
    (music / "junk.mp3").write_bytes(b"junk")
    scanner.run_scan("test")
    assert count(conn) == 2

    os.remove(music / "gone.mp3")
    scanner.run_scan("test")

    assert track_row(conn, "gone.mp3") is None
    assert track_row(conn, "keep.mp3") is not None
    state = scanner.current_state_event()
    assert state["state"] == "idle"


def test_fixed_corrupt_file_indexed_on_rescan(conn, music, scanner):
    """A skipped file is not permanently blacklisted: once the bytes are
    valid, the next scan indexes it."""
    (music / "late.mp3").write_bytes(b"junk")
    scanner.run_scan("test")
    assert track_row(conn, "late.mp3") is None

    make_mp3(music / "late.mp3", title="Recovered", artist="R")
    set_mtime(music / "late.mp3", time.time() + 500)
    scanner.run_scan("test")
    row = track_row(conn, "late.mp3")
    assert row is not None
    assert row["title"] == "Recovered"


# ---- end-to-end: the API survives a corrupt library --------------------------


def test_api_serves_library_with_corrupt_files(client, library, conn):
    resp = client.get("/api/tracks")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "Real"

    health = client.get("/api/health")
    assert health.status_code == 200
