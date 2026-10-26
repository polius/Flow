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
from mutagen.aiff import AIFF
from mutagen.id3 import APIC, ID3, PRIV, TALB, TIT2, TPE1, TPOS, TRCK, TXXX
from mutagen.mp4 import MP4, MP4Cover

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
def test_full_rescan_rebuilds_a_good_copy(conn, music, scanner):
    """Settings → Full rescan re-derives every repaired copy with the
    current pipeline (an older release may have made it), in place."""
    make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    scanner.run_scan("test")
    row = track_row(conn, "song.mp3")
    copy = Path(row["media_path"])
    copy.write_bytes(copy.read_bytes())  # same bytes, new inode
    before = copy.stat().st_ino

    scanner.run_scan("test", full=True)
    after = track_row(conn, "song.mp3")
    assert after["id"] == row["id"]
    assert after["media_path"] == str(copy)
    assert copy.stat().st_ino != before  # promoted over, not reused


@requires_ffmpeg
def test_full_rescan_keeps_the_old_copy_when_the_rebuild_fails(
    conn, music, scanner, monkeypatch
):
    import app.repair as repair

    make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    scanner.run_scan("test")
    copy = Path(track_row(conn, "song.mp3")["media_path"])
    data = copy.read_bytes()

    monkeypatch.setattr(
        repair, "_remux", lambda *a, **k: repair.RepairResult(detail="ffmpeg broke")
    )
    scanner.run_scan("test", full=True)
    row = track_row(conn, "song.mp3")
    assert row["media_path"] == str(copy)
    assert copy.read_bytes() == data
    assert not list(repair.repaired_dir().glob("*.failed"))
    assert scanner.scan_error_log()["items"] == []


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
    so no repair is attempted and the original path indexes directly — but
    as wav (the bytes), so it is served as audio/wav, not audio/mpeg."""
    from app import config

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
    assert row["format"] == "wav"
    assert config.AUDIO_MIME[row["format"]] == "audio/wav"
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


# ---- the audit's eight stream-rip probes ----
# Each shape is generated with ffmpeg at test time, scanned through the real
# pipeline (parse guard → sniff → repair → index), and checked for: the
# container the bytes really are, the format (→ MIME) it streams as, the
# full duration (or the partial-recovery note), the tags including
# track/disc, and the cover.

PROBE_SECONDS = 30
# ~120 KB of "JPEG": big enough to push the payload far past any fixed
# 64 KB sniffing window (probe 2).
BIG_COVER = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 470 + b"\xff\xd9"


def _ffmpeg(*args: str) -> None:
    subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["ffmpeg", "-v", "error", "-nostdin", *args], check=True, capture_output=True
    )


def _sine(seconds: int = PROBE_SECONDS) -> list[str]:
    return ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]


def _encode(work: Path, name: str, *args: str) -> bytes:
    out = work / name
    _ffmpeg(*_sine(), *args, "-y", str(out))
    return out.read_bytes()


def _fragmented_mp4(work: Path) -> bytes:
    return _encode(
        work, "frag.m4a", "-c:a", "aac", "-b:a", "64k",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "ipod",
    )


def _probe_tags(tags) -> None:
    tags.add(TIT2(encoding=3, text="Probe Title"))
    tags.add(TPE1(encoding=3, text="Probe Artist"))
    tags.add(TALB(encoding=3, text="Probe Album"))
    tags.add(TRCK(encoding=3, text="7/12"))
    tags.add(TPOS(encoding=3, text="2/2"))


def _id3_prefix(work: Path, *, cover: bytes | None = None, extra=()) -> bytes:
    """A stream-ripper's ID3v2.3 tag, as raw bytes to glue in front."""
    tags = ID3()
    _probe_tags(tags)
    if cover is not None:
        tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=cover))
    for frame in extra:
        tags.add(frame)
    holder = work / "tag.id3"
    holder.write_bytes(b"")
    tags.save(str(holder), v2_version=3)
    return holder.read_bytes()


def probe_1(work: Path, music: Path) -> Path:
    """ID3 (no cover) + fragmented MP4, named .mp3."""
    path = music / "p1.mp3"
    path.write_bytes(_id3_prefix(work) + _fragmented_mp4(work))
    return path


def probe_2(work: Path, music: Path) -> Path:
    """ID3 with a 120 KB cover + fragmented MP4, named .mp3."""
    path = music / "p2.mp3"
    path.write_bytes(_id3_prefix(work, cover=BIG_COVER) + _fragmented_mp4(work))
    return path


def probe_3(work: Path, music: Path) -> Path:
    """512 B of junk + an MP4 that carries its own tags and cover, named .m4a."""
    raw = work / "tagged.m4a"
    _ffmpeg(
        *_sine(), "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
        "-metadata", "title=Payload Title", "-metadata", "artist=Payload Artist",
        "-metadata", "album=Payload Album", "-metadata", "track=7/12",
        "-metadata", "disc=2/2", "-f", "ipod", "-y", str(raw),
    )
    mp4 = MP4(str(raw))
    mp4["covr"] = [MP4Cover(jpeg_bytes(), imageformat=MP4Cover.FORMAT_JPEG)]
    mp4.save()
    path = music / "p3.m4a"
    path.write_bytes(b"JUNK" * 128 + raw.read_bytes())
    return path


def probe_4(work: Path, music: Path) -> Path:
    """ID3 + raw ADTS AAC, named .mp3."""
    adts = _encode(work, "raw.aac", "-c:a", "aac", "-b:a", "64k", "-f", "adts")
    path = music / "p4.mp3"
    path.write_bytes(_id3_prefix(work) + adts)
    return path


def probe_5(work: Path, music: Path) -> Path:
    """ID3 (cover + ReplayGain) + Ogg Vorbis, named .mp3."""
    ogg = _encode(
        work, "v.ogg", "-ac", "2", "-c:a", "vorbis", "-strict", "-2", "-f", "ogg"
    )
    rg = TXXX(encoding=3, desc="REPLAYGAIN_TRACK_GAIN", text="-6.50 dB")
    path = music / "p5.mp3"
    path.write_bytes(_id3_prefix(work, cover=jpeg_bytes(), extra=[rg]) + ogg)
    return path


def probe_6(work: Path, music: Path) -> Path:
    """AIFF (pcm_s16be) with tags + cover in its ID3 chunk, named .mp3."""
    raw = work / "a.aiff"
    _ffmpeg(*_sine(), "-c:a", "pcm_s16be", "-f", "aiff", "-y", str(raw))
    aiff = AIFF(str(raw))
    aiff.add_tags()
    _probe_tags(aiff.tags)
    aiff.tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=jpeg_bytes()))
    aiff.save()
    path = music / "p6.mp3"
    path.write_bytes(raw.read_bytes())
    return path


def probe_7(work: Path, music: Path) -> Path:
    """ID3 + fragmented MP4 truncated at 50% (a partial download)."""
    data = _fragmented_mp4(work)
    path = music / "p7.mp3"
    path.write_bytes(_id3_prefix(work) + data[: len(data) // 2])
    return path


def probe_8(work: Path, music: Path) -> Path:
    """The bytes "…ftyp" inside an ID3 frame, before the real MP4."""
    decoy = PRIV(owner="decoy", data=b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
    path = music / "p8.mp3"
    path.write_bytes(_id3_prefix(work, extra=[decoy]) + _fragmented_mp4(work))
    return path


# (probe, format, copy extension, MIME, cover bytes or None, partial?)
PROBES = [
    pytest.param(probe_1, "m4a", "m4a", "audio/mp4", None, False, id="1-id3+fmp4"),
    pytest.param(probe_2, "m4a", "m4a", "audio/mp4", BIG_COVER, False, id="2-big-cover"),
    pytest.param(probe_3, "m4a", "m4a", "audio/mp4", jpeg_bytes(), False, id="3-junk+tagged-mp4"),
    pytest.param(probe_4, "m4a", "m4a", "audio/mp4", None, False, id="4-id3+adts"),
    pytest.param(probe_5, "ogg", "ogg", "audio/ogg", jpeg_bytes(), False, id="5-id3+vorbis"),
    pytest.param(probe_6, "wav", "wav", "audio/wav", jpeg_bytes(), False, id="6-aiff"),
    pytest.param(probe_7, "m4a", "m4a", "audio/mp4", None, True, id="7-truncated"),
    pytest.param(probe_8, "m4a", "m4a", "audio/mp4", None, False, id="8-ftyp-decoy-in-tag"),
]


@requires_ffmpeg
@pytest.mark.parametrize(("build", "fmt", "ext", "mime", "cover", "partial"), PROBES)
def test_stream_rip_probe(
    conn, music, scanner, tmp_path, build, fmt, ext, mime, cover, partial
):
    from app import config
    from app.tags import parse_audio

    work = tmp_path / "work"
    work.mkdir()
    src = build(work, music)
    before = src.read_bytes()
    scanner.run_scan("test")

    row = conn.execute(
        "SELECT t.*, ar.name AS artist_name, al.title AS album_title FROM tracks t "
        "LEFT JOIN artists ar ON ar.id = t.artist_id "
        "LEFT JOIN albums al ON al.id = t.album_id WHERE t.path = ?",
        (src.name,),
    ).fetchone()
    assert row is not None, scanner.scan_error_log()
    # Streams as what the bytes are, from a canonical copy.
    assert row["format"] == fmt
    assert config.AUDIO_MIME[row["format"]] == mime
    copy = Path(row["media_path"])
    assert copy.is_file() and copy.suffix == f".{ext}"
    reparsed = parse_audio(copy)
    assert reparsed is not None and reparsed.format == fmt

    log = scanner.scan_error_log()
    if partial:
        # Half the song: indexed anyway, and the scan says so.
        assert 5 < row["duration"] < PROBE_SECONDS * 0.98
        (entry,) = log["items"]
        assert entry["path"] == src.name
        assert "recovered" in entry["reason"]
        assert f"of {PROBE_SECONDS:.1f} s" in entry["reason"]
    else:
        assert row["duration"] == pytest.approx(PROBE_SECONDS, abs=0.5)
        assert log["items"] == []

    # Tags survive — the payload's own (probe 3) or the ID3 prefix's.
    expected = "Payload" if build is probe_3 else "Probe"
    assert row["title"] == f"{expected} Title"
    assert row["artist_name"] == f"{expected} Artist"
    assert row["album_title"] == f"{expected} Album"
    assert row["track_no"] == 7
    assert row["disc_no"] == 2

    # The cover rides along into the copy and the index.
    if cover is None:
        assert reparsed.picture is None
    else:
        assert reparsed.picture is not None and reparsed.picture[0] == cover
        art = conn.execute(
            "SELECT blob FROM artwork WHERE id = ?", (row["artwork_id"],)
        ).fetchone()
        assert art is not None and bytes(art["blob"]) == cover

    if ext == "m4a":
        # +faststart: moov ahead of the media data.
        data = copy.read_bytes()
        assert data.find(b"moov") < data.find(b"mdat")

    # The original is byte-identical after the repair.
    assert src.read_bytes() == before


@requires_ffmpeg
def test_replaygain_carried_into_vorbis_copy(conn, music, scanner, tmp_path):
    from mutagen.oggvorbis import OggVorbis

    work = tmp_path / "work"
    work.mkdir()
    probe_5(work, music)
    scanner.run_scan("test")
    row = track_row(conn, "p5.mp3")
    copy = OggVorbis(row["media_path"])
    assert copy["replaygain_track_gain"] == ["-6.50 dB"]
    assert copy["tracknumber"] == ["7/12"]
    assert copy["discnumber"] == ["2/2"]
    # Re-referenced to the Sound Check target: -6.5 + 4 dB.
    assert row["gain_db"] == pytest.approx(-2.5)


@requires_ffmpeg
def test_alac_payload_becomes_flac(conn, music, scanner, tmp_path):
    """Only Safari decodes ALAC: a rescued ALAC payload is re-encoded to
    FLAC (just as lossless) instead of remuxed into another m4a."""
    work = tmp_path / "work"
    work.mkdir()
    alac = _encode(work, "a.m4a", "-c:a", "alac", "-f", "ipod")
    (music / "alac.mp3").write_bytes(_id3_prefix(work) + alac)
    scanner.run_scan("test")
    row = track_row(conn, "alac.mp3")
    assert row["format"] == "flac"
    assert Path(row["media_path"]).suffix == ".flac"
    assert row["duration"] == pytest.approx(PROBE_SECONDS, abs=0.5)
    assert row["track_no"] == 7


# ---- sniffing ----


def _id3_header(size: int, *, footer: bool = False) -> bytes:
    synch = bytes(
        [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F]
    )
    flags = 0x10 if footer else 0x00
    tail = b"3DI\x04\x00" + bytes([flags]) + synch if footer else b""
    return b"ID3\x04\x00" + bytes([flags]) + synch + b"\x00" * size + tail


def test_sniff_walks_stacked_id3_tags(tmp_path):
    from app.tags import sniff_container

    path = tmp_path / "x.mp3"
    prefix = _id3_header(200_000) + _id3_header(30, footer=True)
    path.write_bytes(prefix + b"OggS\x00\x02" + b"\x00" * 64)
    sniffed = sniff_container(path)
    assert sniffed is not None
    assert (sniffed.container, sniffed.offset) == ("ogg", len(prefix))


@pytest.mark.parametrize(
    ("head", "container"),
    [
        (b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00", "mp4"),
        (b"OggS\x00\x02\x00\x00", "ogg"),
        (b"fLaC\x00\x00\x00\x22", "flac"),
        (b"RIFF\x24\x00\x00\x00WAVEfmt ", "wav"),
        (b"FORM\x00\x00\x00\x00AIFFCOMM", "aiff"),
        (b"\xff\xf1\x50\x80\x00\x1f\xfc", "adts"),
        (b"\xff\xfb\x90\xc4\x00\x00\x00", "mp3"),
        (b"just text, no audio", None),
    ],
)
def test_sniff_magic(tmp_path, head, container):
    from app.tags import sniff_container

    path = tmp_path / "x.bin"
    path.write_bytes(head + b"\x00" * 32)
    sniffed = sniff_container(path)
    assert (sniffed.container if sniffed else None) == container


# ---- lifecycle: failure markers, sweep, upgrade ----


@requires_ffmpeg
def test_known_failure_is_not_reprobed(conn, music, scanner, monkeypatch):
    import app.repair as repair

    (music / "hopeless.mp3").write_bytes(b"\x00" * 4096)
    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")
    first = scanner.scan_error_log()["items"]
    assert any(f.name.endswith(".failed") for f in repair.repaired_dir().iterdir())

    calls = []
    real_run = subprocess.run

    def counting_run(*args, **kwargs):
        calls.append(args[0][0])
        return real_run(*args, **kwargs)

    monkeypatch.setattr(repair.subprocess, "run", counting_run)
    scanner.run_scan("test")
    assert calls == []  # no ffprobe, no stripped copy
    assert scanner.scan_error_log()["items"] == first  # still reported

    # A forced full rescan retries; so does a changed file.
    scanner.run_scan("test", full=True)
    assert calls
    calls.clear()
    (music / "hopeless.mp3").write_bytes(b"\x01" * 4096)
    os_utime(music / "hopeless.mp3", time.time() + 50)
    scanner.run_scan("test")
    assert calls


@requires_ffmpeg
def test_sweep_removes_orphans_and_temp_files(conn, music, scanner):
    from app.repair import repaired_dir

    make_dash_as_mp3(music / "song.mp3", seconds=1.0)
    scanner.run_scan("test")
    kept = Path(track_row(conn, "song.mp3")["media_path"])

    out = repaired_dir()
    orphan = out / "0123456789abcdef0123.m4a"  # a crash between promote and commit
    part = out / "0123456789abcdef0123.m4a.part"  # SIGKILL mid-remux
    stripped = out / ".0123456789abcdef0123.stripped"
    marker = out / "0123456789abcdef0123.failed"  # its file is gone
    stranger = out / "notes.txt"  # not ours: never touched
    for path in (orphan, part, stripped, marker, stranger):
        path.write_bytes(b"x")

    scanner.run_scan("test")
    assert kept.is_file()
    assert stranger.is_file()
    for path in (orphan, part, stripped, marker):
        assert not path.exists(), path


@requires_ffmpeg
def test_upgrade_keeps_existing_copies_and_fixes_misindexed_rows(
    conn, music, scanner, monkeypatch
):
    """After upgrading from v1.5.0: repaired copies keep being served as-is
    (same key, no re-repair), rows indexed with the wrong format are
    corrected on the next scan, and healthy rows are not re-read."""
    import app.scanner as scanner_mod

    make_dash_as_mp3(music / "rip.mp3", seconds=1.0)
    make_mp3(music / "plain.mp3", title="Plain", artist="P")
    _ffmpeg(*_sine(1), "-c:a", "pcm_s16le", "-f", "wav", "-y", str(music / "wave.mp3"))
    scanner.run_scan("test")
    copy = Path(track_row(conn, "rip.mp3")["media_path"])
    copy_mtime = copy.stat().st_mtime_ns

    # What v1.5.0 left behind: the WAV indexed by its extension, and no
    # detection marker in settings.
    conn.execute("UPDATE tracks SET format = 'mp3' WHERE path = 'wave.mp3'")
    conn.execute("DELETE FROM settings WHERE key = 'scan_detect_version'")
    conn.commit()

    parsed = []
    real_parse = scanner_mod.parse_audio

    def counting_parse(path):
        parsed.append(path.name)
        return real_parse(path)

    monkeypatch.setattr(scanner_mod, "parse_audio", counting_parse)
    scanner.run_scan("test")
    assert track_row(conn, "wave.mp3")["format"] == "wav"
    assert parsed == ["wave.mp3"]  # only the contradicted row was re-read
    assert track_row(conn, "rip.mp3")["media_path"] == str(copy)
    assert copy.stat().st_mtime_ns == copy_mtime

    parsed.clear()
    scanner.run_scan("test")  # marker written: no re-check the second time
    assert parsed == []
