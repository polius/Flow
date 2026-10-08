"""Self-healing scan: unparseable files get one lossless repair attempt —
remux into a canonical container under DATA_DIR/repaired/ with the original's
ID3 tags mapped on, verify, then index. Originals are never modified."""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, TRCK
from mutagen.mp4 import MP4

from tests.audio_fixtures import _mp3_frame, jpeg_bytes, make_mp3


def ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


requires_ffmpeg = pytest.mark.skipif(
    not ffmpeg_present(), reason="ffmpeg/ffprobe must be on PATH"
)


@pytest.fixture(autouse=True)
def repair_env(monkeypatch, tmp_path):
    """Repairs write into DATA_DIR/repaired — keep that inside tmp_path."""
    from app import config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


def make_dash_as_mp3(
    path: Path,
    *,
    title: str = "Ripped",
    artist: str = "Ripper",
    album: str | None = None,
    track: str | None = None,
    seconds: float = 1.0,
) -> Path:
    """The exact shape of a stream-rip: fragmented-MP4 (DASH) AAC with an
    .mp3 name and an ID3v2.3 tag glued on the front."""
    raw = path.with_suffix(".dash.m4a")
    subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            "ffmpeg", "-v", "error", "-f", "lavfi",
            "-i", f"sine=frequency=440:duration={seconds}",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            "-f", "ipod", "-y", str(raw),
        ],
        check=True, capture_output=True,
    )
    tags = ID3()
    tags.add(TIT2(encoding=3, text=title))
    tags.add(TPE1(encoding=3, text=artist))
    if album is not None:
        tags.add(TALB(encoding=3, text=album))
    if track is not None:
        tags.add(TRCK(encoding=3, text=track))
    tags.save(str(raw), v2_version=3)  # prepends the ID3v2.3 tag
    path.write_bytes(raw.read_bytes())
    raw.unlink()
    return path


def track_row(conn, rel: str):
    return conn.execute("SELECT * FROM tracks WHERE path = ?", (rel,)).fetchone()


# ---- DASH-as-mp3 ----


@requires_ffmpeg
def test_dash_file_is_repaired_and_indexed(conn, music, scanner):
    src = make_dash_as_mp3(music / "Ripped Song.mp3", title="Bolangera",
                           artist="Malimpré", album="Onze", track="7/12")
    before = src.read_bytes()
    scanner.run_scan("test")

    row = track_row(conn, "Ripped Song.mp3")
    assert row is not None
    assert row["format"] == "m4a"  # the format that actually streams
    assert row["media_path"] is not None
    copy = Path(row["media_path"])
    assert copy.is_file()
    assert copy.parent.name == "repaired"
    assert row["duration"] > 0.5
    assert scanner.current_state_event()["errors"] == 0

    # The ID3 tag from the broken original rode along.
    from mutagen.mp4 import MP4

    tags = MP4(str(copy))
    assert tags["\xa9nam"] == ["Bolangera"]
    assert tags["\xa9ART"] == ["Malimpré"]
    assert tags["\xa9alb"] == ["Onze"]
    assert tags["trkn"] == [(7, 12)]

    # The original is byte-identical after the repair.
    assert src.read_bytes() == before


@requires_ffmpeg
def test_dash_rip_with_decoy_sync_still_repaired(conn, music, scanner):
    """The rip's ISO-BMFF payload can contain bytes that pass mutagen's
    frame-sync validation: mutagen then returns an MP3 verdict and the
    failure-path mislabel sniff never runs. The success path must still
    refuse the mp3 index (the bytes are an MP4) and take the repair."""
    src = make_dash_as_mp3(music / "Decoy Song.mp3", title="Decoy", artist="R")
    data = src.read_bytes()
    id3_end = 10 + (
        (data[6] & 0x7F) << 21
        | (data[7] & 0x7F) << 14
        | (data[8] & 0x7F) << 7
        | (data[9] & 0x7F)
    )
    # Two consecutive valid silent MPEG frames right after the tag: mutagen
    # requires 2+ chained frames to commit to a verdict, finds them, and
    # happily reports an MP3 — exactly what real rips' payloads do by luck.
    src.write_bytes(data[:id3_end] + _mp3_frame(128) * 2 + data[id3_end:])
    before = src.read_bytes()
    scanner.run_scan("test")

    row = track_row(conn, "Decoy Song.mp3")
    assert row is not None
    assert row["format"] == "m4a"  # not mp3: the payload is ISO-BMFF
    assert row["media_path"] is not None
    assert Path(row["media_path"]).is_file()
    assert row["duration"] > 0.5
    assert scanner.current_state_event()["errors"] == 0
    # The original is byte-identical after the repair.
    assert src.read_bytes() == before


# ---- repair is lossless remux, and idempotent ----


@requires_ffmpeg
def test_repaired_copy_is_reused_while_original_is_unchanged(conn, music, scanner):
    make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    scanner.run_scan("test")
    first = track_row(conn, "song.mp3")["media_path"]
    stat_first = Path(first).stat()

    scanner.run_scan("test")  # nothing changed on disk
    row = track_row(conn, "song.mp3")
    assert row["media_path"] == first
    stat_second = Path(first).stat()
    assert (stat_first.st_mtime_ns, stat_first.st_size) == (
        stat_second.st_mtime_ns,
        stat_second.st_size,
    )  # reused, not re-derived


@requires_ffmpeg
def test_deleted_repaired_copy_is_re_derived(conn, music, scanner):
    make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    scanner.run_scan("test")
    copy = Path(track_row(conn, "song.mp3")["media_path"])
    copy.unlink()  # data dir cleaned out-of-band

    scanner.run_scan("test")
    row = track_row(conn, "song.mp3")
    assert row["media_path"] is not None
    assert Path(row["media_path"]).is_file()
    assert row["media_path"] == str(copy)  # same key → same name, rebuilt


# ---- invalidation: original replaced or removed ----


@requires_ffmpeg
def test_replaced_original_unheals_and_cleans_up(conn, music, scanner):
    src = make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    scanner.run_scan("test")
    stale_copy = Path(track_row(conn, "song.mp3")["media_path"])
    assert stale_copy.is_file()

    make_mp3(music / "song.mp3", title="Real", artist="R")  # user fixed the file
    os_utime(src, time.time() + 500)
    scanner.run_scan("test")

    row = track_row(conn, "song.mp3")
    assert row["media_path"] is None  # streams the real file again
    assert row["format"] == "mp3"
    assert row["title"] == "Real"
    assert not stale_copy.exists()  # orphaned copy collected


@requires_ffmpeg
def test_removed_original_cleans_up_repaired_copy(conn, music, scanner):
    make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    make_mp3(music / "keeper.mp3", title="Keep", artist="K")  # walk stays non-empty
    scanner.run_scan("test")
    copy = Path(track_row(conn, "song.mp3")["media_path"])
    assert copy.is_file()

    (music / "song.mp3").unlink()
    scanner.run_scan("test")
    assert track_row(conn, "song.mp3") is None
    assert track_row(conn, "keeper.mp3") is not None
    assert not copy.exists()


# ---- opt-out and hopeless files ----


@requires_ffmpeg
def test_repair_disabled_keeps_plain_error_log(conn, music, scanner, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "REPAIR", False)
    make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    scanner.run_scan("test")

    assert track_row(conn, "song.mp3") is None
    state = scanner.current_state_event()
    assert state["errors"] == 1
    entries = scanner.scan_error_log()["items"]
    assert entries[0]["reason"] == "Unreadable or unrecognized audio file"


@requires_ffmpeg
def test_genuinely_corrupt_file_reports_the_failed_repair(conn, music, scanner):
    # Big enough to clear the attempt threshold, hopeless by content.
    (music / "hopeless.mp3").write_bytes(b"\x00" * 4096)
    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")

    assert track_row(conn, "hopeless.mp3") is None
    entries = scanner.scan_error_log()["items"]
    by_path = {e["path"]: e["reason"] for e in entries}
    assert "repair attempted but failed" in by_path["hopeless.mp3"]


@requires_ffmpeg
def test_wav_content_in_mp3_name_indexes_directly(conn, music, scanner):
    """mutagen sniffs content, not names: PCM in a .mp3 file parses as-is,
    so no repair is attempted and the original path indexes directly."""
    subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            "ffmpeg", "-v", "error", "-f", "lavfi",
            "-i", "sine=frequency=440:duration=1",
            "-c:a", "pcm_s16le", "-f", "wav", "-y", str(music / "wave.mp3"),
        ],
        check=True, capture_output=True,
    )
    scanner.run_scan("test")
    row = track_row(conn, "wave.mp3")
    assert row is not None
    assert row["media_path"] is None  # nothing needed healing
    assert row["duration"] == pytest.approx(1.0, abs=0.1)
    assert row["sample_rate"] == 44100


# ---- artwork ----


@requires_ffmpeg
def test_repaired_track_falls_back_to_folder_cover_silently(
    conn, music, scanner, caplog
):
    """The repaired track's ORIGINAL is unparseable by mutagen — artwork
    resolution must not try to extract embedded art from it. Folder covers
    still apply."""
    make_dash_as_mp3(music / "song.mp3", seconds=1.0, title="T", artist="A")
    (music / "cover.jpg").write_bytes(jpeg_bytes())
    with caplog.at_level(logging.WARNING, logger="flow.artwork"):
        scanner.run_scan("test")

    row = track_row(conn, "song.mp3")
    assert row is not None
    assert row["artwork_id"] is not None  # the folder cover applied
    assert [r for r in caplog.records if r.name == "flow.artwork"] == []


@requires_ffmpeg
def test_embedded_cover_from_broken_original_rides_along(conn, music, scanner):
    """A stream-rip whose ID3 prefix carries a cover keeps it: APIC frames
    are mapped onto the remux's covr atom, and the scanner picks them up."""
    src = make_dash_as_mp3(music / "art.mp3", seconds=1.0, title="Art", artist="B")
    tags = ID3(src)
    tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=jpeg_bytes()))
    tags.save(str(src), v2_version=3)
    scanner.run_scan("test")

    row = track_row(conn, "art.mp3")
    assert row is not None and row["media_path"] is not None
    covr = MP4(str(Path(row["media_path"]))).tags.get("covr")
    assert covr is not None
    assert bytes(covr[0]) == jpeg_bytes()
    assert row["artwork_id"] is not None


# ---- streaming ----


@requires_ffmpeg
def test_repaired_track_streams_direct_mode(client, library):
    conn = client.app.state.db.connect()
    row = conn.execute(
        "SELECT id, media_path FROM tracks WHERE media_path IS NOT NULL"
    ).fetchone()
    assert row is not None  # the library fixture holds a stream-rip
    resp = client.get(f"/api/stream/{row['id']}")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/mp4")


@requires_ffmpeg
def test_repaired_track_streams_via_nginx_redirect(client, library, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "STREAM_MODE", "nginx")
    conn = client.app.state.db.connect()
    row = conn.execute(
        "SELECT id, media_path FROM tracks WHERE media_path IS NOT NULL"
    ).fetchone()
    resp = client.get(f"/api/stream/{row['id']}")
    assert resp.status_code == 200
    redirect = resp.headers["X-Accel-Redirect"]
    assert redirect.startswith("/repaired-internal/")
    assert Path(row["media_path"]).name in redirect


def os_utime(path: Path, epoch: float) -> None:
    import os

    os.utime(path, (epoch, epoch))


@pytest.fixture
def library(music):
    """For the streaming tests: one stream-rip + one normal file, present
    before the client fixture's synchronous scan."""
    make_dash_as_mp3(music / "Rip.mp3", seconds=1.0)
    make_mp3(music / "plain.mp3", title="Plain", artist="P")
    return music
