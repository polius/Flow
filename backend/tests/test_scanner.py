"""Scanner semantics: parsing, overlays, moves, removals."""

from __future__ import annotations

import os
import sqlite3
import sys
import threading
import time
import unicodedata
from pathlib import Path

import pytest

from app.scanner import Edited, _utcnow
from tests.audio_fixtures import jpeg_bytes, make_flac, make_mp3, png_bytes


def track_row(conn, rel: str):
    return conn.execute("SELECT * FROM tracks WHERE path = ?", (rel,)).fetchone()


def set_mtime(path, epoch: float) -> None:
    os.utime(path, (epoch, epoch))


def test_parses_tags_and_builds_entities(conn, music, scanner):
    art = jpeg_bytes()
    make_mp3(
        music / "Artist" / "Album" / "01 - First.mp3",
        title="First Song",
        artist="Artist",
        albumartist="Artist",
        album="Album",
        track="1/10",
        disc="1",
        year="2004",
        picture=art,
    )
    scanner.run_scan("test")

    row = track_row(conn, "Artist/Album/01 - First.mp3")
    assert row is not None
    assert row["title"] == "First Song"
    assert row["track_no"] == 1
    assert row["disc_no"] == 1
    assert row["year"] == 2004
    assert row["format"] == "mp3"
    assert row["duration"] > 4.0
    assert row["size"] == (music / "Artist/Album/01 - First.mp3").stat().st_size
    assert row["bitrate"] == 128000
    assert row["sample_rate"] == 44100

    artist = conn.execute("SELECT * FROM artists WHERE name = 'Artist'").fetchone()
    assert artist is not None
    assert row["artist_id"] == artist["id"]
    assert row["album_artist_id"] == artist["id"]

    album = conn.execute("SELECT * FROM albums WHERE title = 'Album'").fetchone()
    assert album is not None
    assert album["artist_id"] == artist["id"]
    assert album["year"] == 2004
    assert album["artwork_id"] == row["artwork_id"]

    artwork = conn.execute("SELECT * FROM artwork WHERE id = ?", (row["artwork_id"],)).fetchone()
    assert artwork["mime"] == "image/jpeg"


def test_flac_parsing_and_picture(conn, music, scanner):
    make_flac(
        music / "a" / "01 - Song.flac",
        title="Flac Song",
        artist="Flac Artist",
        album="Flac Album",
        picture=png_bytes(),
    )
    scanner.run_scan("test")

    row = track_row(conn, "a/01 - Song.flac")
    assert row["title"] == "Flac Song"
    assert row["format"] == "flac"
    assert row["duration"] == pytest.approx(5.0, abs=0.5)
    artwork = conn.execute("SELECT * FROM artwork WHERE id = ?", (row["artwork_id"],)).fetchone()
    assert artwork["mime"] == "image/png"


def test_filename_fallback_when_tags_missing(conn, music, scanner):
    make_mp3(music / "07 - Song Title.mp3")
    scanner.run_scan("test")

    row = track_row(conn, "07 - Song Title.mp3")
    assert row["title"] == "Song Title"
    assert row["track_no"] == 7
    assert row["artist_id"] is None
    assert row["album_id"] is None


def test_artwork_dedup_across_tracks(conn, music, scanner):
    art = jpeg_bytes()
    make_mp3(music / "a" / "01.mp3", title="One", artist="A", album="X", picture=art)
    make_mp3(music / "a" / "02.mp3", title="Two", artist="A", album="X", picture=art)
    scanner.run_scan("test")

    assert conn.execute("SELECT COUNT(*) c FROM artwork").fetchone()["c"] == 1


def test_folder_artwork_fallback(conn, music, scanner):
    # No embedded art; cover.jpg sits next to the track.
    make_mp3(music / "b" / "01.mp3", title="Bare", artist="B", album="Y")
    (music / "b" / "cover.jpg").write_bytes(jpeg_bytes())
    scanner.run_scan("test")

    row = track_row(conn, "b/01.mp3")
    assert row["artwork_id"] is not None
    artwork = conn.execute("SELECT * FROM artwork WHERE id = ?", (row["artwork_id"],)).fetchone()
    assert artwork["mime"] == "image/jpeg"


def test_untouched_file_not_reparsed_and_edits_survive(conn, music, scanner):
    make_mp3(music / "01.mp3", title="Orig", artist="Orig Artist", album="Orig Album")
    scanner.run_scan("test")
    row = track_row(conn, "01.mp3")

    # Simulate the Get Info editor: user renames the title.
    conn.execute(
        "UPDATE tracks SET title = 'User Title', user_edited = ? WHERE path = '01.mp3'",
        (int(Edited.TITLE),),
    )
    track_id = row["id"]

    # Rescan with nothing changed on disk → row must be untouched.
    scanner.run_scan("test")
    row = track_row(conn, "01.mp3")
    assert row["id"] == track_id
    assert row["title"] == "User Title"

    # Re-tag the file and bump mtime → tag fields refresh, overlay re-applied.
    make_mp3(music / "01.mp3", title="Retagged", artist="New Artist", album="Orig Album")
    set_mtime(music / "01.mp3", time.time() + 500)
    scanner.run_scan("test")

    row = track_row(conn, "01.mp3")
    assert row["id"] == track_id  # same row, updated in place
    assert row["title"] == "User Title"  # overlay wins
    artist = conn.execute("SELECT name FROM artists WHERE id = ?", (row["artist_id"],)).fetchone()
    assert artist["name"] == "New Artist"  # non-edited field follows tags


def test_move_preserves_row_and_overlay(conn, music, scanner):
    make_mp3(music / "old" / "01.mp3", title="Keep Me", artist="M", album="MM")
    scanner.run_scan("test")
    row = track_row(conn, "old/01.mp3")
    track_id = row["id"]
    conn.execute(
        "UPDATE tracks SET title = 'User Title', user_edited = ? WHERE id = ?",
        (int(Edited.TITLE), track_id),
    )

    (music / "new").mkdir()
    os.rename(music / "old" / "01.mp3", music / "new" / "01.mp3")
    scanner.run_scan("test")

    assert track_row(conn, "old/01.mp3") is None
    moved = track_row(conn, "new/01.mp3")
    assert moved is not None
    assert moved["id"] == track_id  # same row — a move, not delete+add
    assert moved["title"] == "User Title"
    assert conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"] == 1


def test_ambiguous_move_does_not_invent_a_match(conn, music, scanner):
    # Two identical copies (same size, same mtime) removed; one identical
    # file appears elsewhere → matching is ambiguous, so: one remove + one add.
    art = jpeg_bytes()
    for name in ("a/01.mp3", "a/02.mp3"):
        make_mp3(music / name, title="Twin", artist="T", album="TT", picture=art)
        set_mtime(music / name, 1_700_000_000)
    scanner.run_scan("test")

    os.remove(music / "a" / "01.mp3")
    os.remove(music / "a" / "02.mp3")
    make_mp3(music / "b" / "01.mp3", title="Twin", artist="T", album="TT", picture=art)
    set_mtime(music / "b" / "01.mp3", 1_700_000_000)
    scanner.run_scan("test")

    assert track_row(conn, "a/01.mp3") is None
    assert track_row(conn, "a/02.mp3") is None
    assert track_row(conn, "b/01.mp3") is not None
    assert conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"] == 1


def test_removal_cascades_playlists_and_prunes_orphans(conn, music, scanner):
    # Two independent artists/albums; deleting one track cascades and prunes
    # its derived entities while the rest of the library survives.
    make_mp3(
        music / "01.mp3",
        title="Gone",
        artist="Only Artist",
        album="Only Album",
        picture=jpeg_bytes(),
    )
    make_mp3(music / "02.mp3", title="Stays", artist="Other Artist", album="Other Album")
    scanner.run_scan("test")
    track = track_row(conn, "01.mp3")
    conn.execute(
        "INSERT INTO playlists (name, created_at) VALUES ('Mix', ?)", (_utcnow(),)
    )
    playlist = conn.execute("SELECT id FROM playlists").fetchone()
    conn.execute(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, 1)",
        (playlist["id"], track["id"]),
    )

    os.remove(music / "01.mp3")
    scanner.run_scan("test")

    assert track_row(conn, "01.mp3") is None
    assert track_row(conn, "02.mp3") is not None
    assert conn.execute("SELECT COUNT(*) c FROM playlist_tracks").fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM playlists").fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM artists").fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM albums").fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM artwork").fetchone()["c"] == 0


def test_album_survives_while_other_tracks_reference_it(conn, music, scanner):
    make_mp3(music / "a" / "01.mp3", title="One", artist="A", album="Shared")
    make_mp3(music / "a" / "02.mp3", title="Two", artist="A", album="Shared")
    scanner.run_scan("test")

    os.remove(music / "a" / "01.mp3")
    scanner.run_scan("test")

    album = conn.execute("SELECT * FROM albums WHERE title = 'Shared'").fetchone()
    assert album is not None
    assert conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"] == 1


def test_corrupt_file_skipped_not_fatal(conn, music, scanner):
    (music / "broken.mp3").write_bytes(b"this is not audio")
    (music / "empty.mp3").write_bytes(b"")
    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")

    assert track_row(conn, "good.mp3") is not None
    assert track_row(conn, "broken.mp3") is None
    assert track_row(conn, "empty.mp3") is None
    assert scanner.current_state_event()["state"] == "idle"


def test_empty_walk_against_nonempty_index_refuses_to_delete(conn, music, scanner):
    """Broken-mount guard: an empty library folder must not mass-delete a
    populated index (infrastructure glitch ≠ user action)."""
    make_mp3(music / "01.mp3", title="Precious", artist="P")
    scanner.run_scan("test")
    assert conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"] == 1

    # Simulate the mount vanishing: the walk now sees nothing.
    (music / "01.mp3").unlink()
    scanner.run_scan("test")

    row = track_row(conn, "01.mp3")
    assert row is not None
    assert row["title"] == "Precious"
    assert scanner.current_state_event()["errors"] == 1


def test_scan_state_persisted_to_settings(conn, music, scanner):
    make_mp3(music / "01.mp3", title="T")
    scanner.run_scan("test")

    persisted = {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM settings")
    }
    assert persisted["scan_state"] == "idle"
    assert persisted["scan_errors"] == "0"
    assert persisted["scan_finished_at"]


def test_scan_events_carry_finished_at(conn, music, db):
    """The UI's 'Last scan' reads the SSE stream: the final idle event must
    include finished_at, or the store wipes it back to 'never'."""
    from app.scanner import LibraryScanner

    events = []

    class RecordingBus:
        def publish(self, event: dict) -> None:
            events.append(event)

    scanner = LibraryScanner(db, music, RecordingBus())
    make_mp3(music / "01.mp3", title="T")
    scanner.run_scan("test")

    idle = events[-1]
    assert idle["state"] == "idle"
    assert idle["finished_at"]


def test_hidden_and_unsupported_files_ignored(conn, music, scanner):
    make_mp3(music / "01.mp3", title="T")
    (music / ".hidden" / "02.mp3").parent.mkdir()
    make_mp3(music / ".hidden" / "02.mp3", title="Hidden")
    (music / "notes.txt").write_bytes(b"nope")
    (music / "._resource.mp3").write_bytes(b"apple double")
    scanner.run_scan("test")

    assert conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"] == 1


# ---- unreadable folders never delete (B2) ----


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission model")
@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root reads anything")
def test_unreadable_folder_keeps_its_tracks_and_user_data(conn, music, scanner):
    """The audit's repro: chmod 0 a folder, scan, restore. The folder's
    tracks — with their favorite, playlist entry and edit — must survive."""
    make_mp3(music / "Locked" / "01.mp3", title="Precious", artist="P", album="L")
    make_mp3(music / "Open" / "01.mp3", title="Other", artist="O", album="O")
    scanner.run_scan("test")
    row = track_row(conn, "Locked/01.mp3")
    conn.execute(
        "UPDATE tracks SET favorite = 1, title = 'My Title', user_edited = ? WHERE id = ?",
        (int(Edited.TITLE), row["id"]),
    )
    conn.execute("INSERT INTO playlists (name, created_at) VALUES ('Mix', ?)", (_utcnow(),))
    conn.execute(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position) "
        "VALUES ((SELECT id FROM playlists), ?, 1)",
        (row["id"],),
    )
    conn.commit()

    os.chmod(music / "Locked", 0)
    try:
        scanner.run_scan("test")
    finally:
        os.chmod(music / "Locked", 0o755)

    kept = track_row(conn, "Locked/01.mp3")
    assert kept is not None and kept["id"] == row["id"]
    assert kept["favorite"] == 1 and kept["title"] == "My Title"
    assert conn.execute("SELECT COUNT(*) c FROM playlist_tracks").fetchone()["c"] == 1
    items = scanner.scan_error_log()["items"]
    assert any(i["path"] == "Locked" and "removals skipped" in i["reason"] for i in items)

    scanner.run_scan("test")  # readable again: business as usual
    assert track_row(conn, "Locked/01.mp3")["favorite"] == 1
    assert scanner.scan_error_log()["items"] == []


# ---- queued rescans + interruptible analysis (B3) ----


def _wait_idle(scanner, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while scanner.scanning:
        assert time.monotonic() < deadline, "scan never finished"
        time.sleep(0.01)


def test_scan_requested_during_scan_is_queued_not_dropped(music, scanner, monkeypatch):
    runs: list[tuple[str, bool]] = []
    release = threading.Event()
    real = scanner._reconcile

    def slow_reconcile(trigger, full=False, **kwargs):
        runs.append((trigger, full))
        if len(runs) == 1:
            assert release.wait(5)
        real(trigger, full=full, **kwargs)

    monkeypatch.setattr(scanner, "_reconcile", slow_reconcile)
    make_mp3(music / "01.mp3", title="T")
    assert scanner.start_scan("manual")
    time.sleep(0.05)
    # A watcher event and a manual full rescan while the first runs: both
    # accepted (no 409), coalesced into ONE follow-up that is full.
    assert scanner.start_scan("watch")
    assert scanner.start_scan("manual", full=True)
    release.set()
    _wait_idle(scanner)
    assert runs == [("manual", False), ("watch", True)]


def test_queued_scan_interrupts_and_then_resumes_analysis(
    conn, music, scanner, monkeypatch
):
    for i in range(3):
        make_mp3(music / f"{i}.mp3", title=f"T{i}", artist="A")
    events: list[str] = []
    real = scanner._reconcile

    def recording_reconcile(trigger, full=False, **kwargs):
        events.append(f"reconcile:{trigger}")
        real(trigger, full=full, **kwargs)

    def fake_analyze(path):
        events.append(f"analyze:{path.name}")
        if path.name == "0.mp3":
            scanner.start_scan("watch")  # a change lands mid-analysis
        return -3.0

    monkeypatch.setattr(scanner, "_reconcile", recording_reconcile)
    monkeypatch.setattr("app.scanner.ffmpeg_available", lambda: True)
    monkeypatch.setattr("app.scanner.analyze_file", fake_analyze)
    scanner.start_scan("manual")
    _wait_idle(scanner)

    assert events == [
        "reconcile:manual",
        "analyze:0.mp3",
        "reconcile:watch",  # the follow-up ran before analysis went on
        "analyze:1.mp3",
        "analyze:2.mp3",
    ]
    gains = [r["gain_db"] for r in conn.execute("SELECT gain_db FROM tracks")]
    assert gains == [-3.0, -3.0, -3.0]
    assert scanner.current_state_event()["state"] == "idle"


@pytest.mark.parametrize("measurable", [True, False])
def test_scan_with_analysis_goes_idle_once(music, db, monkeypatch, measurable):
    """Reconcile → loudness pass is one scan to the UI: an idle between
    them flashed "Last scan" before "Analyzing audio… 0/1"."""
    from app.scanner import LibraryScanner

    states: list[tuple[str, str | None]] = []

    class RecordingBus:
        def publish(self, event: dict) -> None:
            states.append((event["state"], event["phase"]))

    scanner = LibraryScanner(db, music, RecordingBus())
    make_mp3(music / "01.mp3", title="T")
    monkeypatch.setattr("app.scanner.ffmpeg_available", lambda: True)
    monkeypatch.setattr(
        "app.scanner.analyze_file", lambda path: -3.0 if measurable else None
    )
    scanner.start_scan("manual")
    _wait_idle(scanner)

    assert [s for s, _ in states].count("idle") == 1
    assert states[-1] == ("idle", None)
    assert ("scanning", "analyze") in states


def test_scan_without_analysis_still_goes_idle(music, db, monkeypatch):
    from app.scanner import LibraryScanner

    states: list[str] = []

    class RecordingBus:
        def publish(self, event: dict) -> None:
            states.append(event["state"])

    scanner = LibraryScanner(db, music, RecordingBus())
    make_mp3(music / "01.mp3", title="T")
    monkeypatch.setattr("app.scanner.ffmpeg_available", lambda: False)
    scanner.start_scan("manual")
    _wait_idle(scanner)

    assert states[-1] == "idle"
    assert states.count("idle") == 1


# ---- edits made during a scan win (B5) ----


def test_edit_saved_during_scan_is_not_overwritten(db, conn, music, scanner, monkeypatch):
    import app.scanner as scanner_mod

    make_mp3(music / "01.mp3", title="Tag Title", artist="A")
    scanner.run_scan("test")
    track_id = track_row(conn, "01.mp3")["id"]
    make_mp3(music / "01.mp3", title="New Tag Title", artist="A")
    set_mtime(music / "01.mp3", time.time() + 100)

    real_parse = scanner_mod.parse_audio

    def parse_while_user_edits(path):
        # Get Info saves from another connection while the scan works.
        other = sqlite3.connect(db.path)
        other.execute(
            "UPDATE tracks SET title = 'User Title', user_edited = ? WHERE id = ?",
            (int(Edited.TITLE), track_id),
        )
        other.commit()
        other.close()
        return real_parse(path)

    monkeypatch.setattr(scanner_mod, "parse_audio", parse_while_user_edits)
    scanner.run_scan("test")
    row = track_row(conn, "01.mp3")
    assert row["title"] == "User Title"
    assert row["user_edited"] == int(Edited.TITLE)


# ---- Unicode identity (B8) ----


def test_unicode_spellings_are_one_artist_and_album(conn, music, scanner):
    nfc = "Beyoncé"
    nfd = unicodedata.normalize("NFD", nfc)
    assert nfd != nfc
    make_mp3(music / "1.mp3", title="One", artist=nfc, albumartist=nfc, album="Déjà Vu")
    make_mp3(music / "2.mp3", title="Two", artist=nfd, albumartist=nfd,
             album=unicodedata.normalize("NFD", "Déjà Vu"))
    make_mp3(music / "3.mp3", title="Three", artist="BEYONCÉ", albumartist="BEYONCÉ",
             album="DÉJÀ VU")
    scanner.run_scan("test")

    artists = conn.execute("SELECT name FROM artists").fetchall()
    albums = conn.execute("SELECT title FROM albums").fetchall()
    assert [a["name"] for a in artists] == [nfc]  # stored NFC
    assert [a["title"] for a in albums] == ["Déjà Vu"]
    titles = {r["title"] for r in conn.execute("SELECT title FROM tracks")}
    assert titles == {"One", "Two", "Three"}


def test_name_key_backfill_tolerates_existing_duplicates(tmp_path):
    """A v1.5.0 database can already hold rows that collide under the new
    key (NFC + NFD spellings). Migrating and backfilling must not fail, and
    lookups must pick one row deterministically (the lowest id)."""
    from app.db import Database
    from app.entities import (
        backfill_name_keys,
        find_or_create_album,
        find_or_create_artist,
    )

    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(
        (Path(__file__).resolve().parent.parent / "app/migrations/001_init.sql").read_text()
    )
    old.execute("PRAGMA user_version = 1")
    nfd = unicodedata.normalize("NFD", "Beyoncé")
    old.execute("INSERT INTO artists (id, name) VALUES (5, ?)", ("Beyoncé",))
    old.execute("INSERT INTO artists (id, name) VALUES (9, ?)", (nfd,))
    old.execute("INSERT INTO albums (id, title, artist_id) VALUES (3, 'Déjà Vu', 5)")
    old.execute("INSERT INTO albums (id, title, artist_id) VALUES (4, 'DÉJÀ VU', 5)")
    old.commit()
    old.close()

    database = Database(path)
    database.init()  # migration 003 on real, colliding data
    conn = database.connect()
    backfill_name_keys(conn)
    assert backfill_name_keys(conn) == 0  # idempotent
    keys = {r["id"]: r["name_key"] for r in conn.execute("SELECT id, name_key FROM artists")}
    assert keys[5] == keys[9]
    assert find_or_create_artist(conn, "BEYONCÉ") == 5
    assert find_or_create_album(conn, unicodedata.normalize("NFD", "déjà vu"), 5, None) == 3
    database.close_thread()


# ---- compilations (B10) ----


def test_compilation_flag_groups_under_various_artists(conn, music, scanner):
    from mutagen.id3 import ID3, TCMP

    for i, artist in enumerate(("Ann", "Bob")):
        path = make_mp3(music / f"{i}.mp3", title=f"T{i}", artist=artist, album="Hits 2000")
        tags = ID3(str(path))
        tags.add(TCMP(encoding=3, text="1"))
        tags.save(str(path))
    make_flac(music / "2.flac", title="T2", artist="Cy", album="Hits 2000")
    from mutagen.flac import FLAC

    flac = FLAC(str(music / "2.flac"))
    flac["compilation"] = ["1"]
    flac.save()
    scanner.run_scan("test")

    albums = conn.execute(
        "SELECT al.title, ar.name FROM albums al JOIN artists ar ON ar.id = al.artist_id"
    ).fetchall()
    assert [(a["title"], a["name"]) for a in albums] == [("Hits 2000", "Various Artists")]


# ---- retag-and-move keeps user state (B13) ----


def test_retagged_move_keeps_row_and_user_state(conn, music, scanner):
    make_mp3(music / "Inbox" / "track.mp3", title="Song", artist="Band", album="Record")
    make_mp3(music / "Inbox" / "other.mp3", title="Else", artist="Band", album="Record",
             seconds=3.0)
    scanner.run_scan("test")
    row = track_row(conn, "Inbox/track.mp3")
    conn.execute("UPDATE tracks SET favorite = 1, played_at = 'x' WHERE id = ?", (row["id"],))
    conn.commit()

    # A tagger moves AND rewrites the file: new path, new bytes, new mtime.
    os.remove(music / "Inbox" / "track.mp3")
    make_mp3(music / "Band" / "Record" / "01 Song.mp3", title="Song", artist="Band",
             album="Record", track="1", genre="Rock")
    set_mtime(music / "Band" / "Record" / "01 Song.mp3", time.time() + 100)
    scanner.run_scan("test")

    moved = track_row(conn, "Band/Record/01 Song.mp3")
    assert moved is not None and moved["id"] == row["id"]
    assert moved["favorite"] == 1 and moved["played_at"] == "x"
    assert moved["track_no"] == 1  # and the new tags were read
    assert track_row(conn, "Inbox/track.mp3") is None


def test_retagged_move_with_two_candidates_is_not_guessed(conn, music, scanner):
    for name in ("a.mp3", "b.mp3"):
        make_mp3(music / "old" / name, title="Same", artist="Band", album="Record")
    scanner.run_scan("test")
    ids = {r["id"] for r in conn.execute("SELECT id FROM tracks")}
    os.remove(music / "old" / "a.mp3")
    os.remove(music / "old" / "b.mp3")
    make_mp3(music / "new" / "c.mp3", title="Same", artist="Band", album="Record", genre="X")
    scanner.run_scan("test")
    (row,) = conn.execute("SELECT id FROM tracks").fetchall()
    assert row["id"] not in ids  # a fresh row: ambiguity is never resolved by guessing


# ---- folder art refresh (B14) ----


def test_replaced_folder_cover_refreshes_album_art(conn, music, scanner):
    make_mp3(music / "a" / "01.mp3", title="One", artist="A", album="X")
    (music / "a" / "cover.jpg").write_bytes(jpeg_bytes())
    scanner.run_scan("test")
    album = conn.execute("SELECT artwork_id FROM albums").fetchone()
    old_art = album["artwork_id"]
    assert old_art is not None

    new_cover = jpeg_bytes()[:-2] + b"\x01\x02\xff\xd9"
    (music / "a" / "cover.jpg").write_bytes(new_cover)
    set_mtime(music / "a" / "cover.jpg", time.time() + 100)
    scanner.run_scan("test")
    album = conn.execute("SELECT artwork_id FROM albums").fetchone()
    assert album["artwork_id"] != old_art
    blob = conn.execute(
        "SELECT blob FROM artwork WHERE id = ?", (album["artwork_id"],)
    ).fetchone()["blob"]
    assert bytes(blob) == new_cover
    assert track_row(conn, "a/01.mp3")["artwork_id"] == album["artwork_id"]


# ---- change detection: size + full rescan (B15) ----


def test_size_change_with_preserved_mtime_is_reread(conn, music, scanner):
    make_mp3(music / "01.mp3", title="Before", artist="A")
    set_mtime(music / "01.mp3", 1_700_000_000)
    scanner.run_scan("test")
    make_mp3(music / "01.mp3", title="After, longer title", artist="A")
    set_mtime(music / "01.mp3", 1_700_000_000)  # the tagger preserved it
    scanner.run_scan("test")
    assert track_row(conn, "01.mp3")["title"] == "After, longer title"


def test_full_rescan_rereads_unchanged_files(conn, music, scanner):
    make_mp3(music / "01.mp3", title="AAAA", artist="A")
    set_mtime(music / "01.mp3", 1_700_000_000)
    scanner.run_scan("test")
    make_mp3(music / "01.mp3", title="BBBB", artist="A")  # same size
    set_mtime(music / "01.mp3", 1_700_000_000)
    scanner.run_scan("test")
    assert track_row(conn, "01.mp3")["title"] == "AAAA"  # invisible to mtime + size
    scanner.run_scan("test", full=True)
    assert track_row(conn, "01.mp3")["title"] == "BBBB"


# ---- one bad file never aborts the scan (B18) ----


def test_unexpected_error_is_logged_per_file(conn, music, scanner, monkeypatch):
    import app.scanner as scanner_mod

    make_mp3(music / "01.mp3", title="Fine", artist="A", album="Good")
    make_mp3(music / "02.mp3", title="Boom", artist="A", album="Bad")
    make_mp3(music / "03.mp3", title="Fine too", artist="A", album="Good")
    real = scanner_mod.find_or_create_album

    def flaky(conn_, title, artist_id, year):
        if title == "Bad":
            raise RuntimeError("disk on fire")
        return real(conn_, title, artist_id, year)

    monkeypatch.setattr(scanner_mod, "find_or_create_album", flaky)
    scanner.run_scan("test")
    assert track_row(conn, "01.mp3") is not None
    assert track_row(conn, "03.mp3") is not None
    assert track_row(conn, "02.mp3") is None
    (item,) = scanner.scan_error_log()["items"]
    assert item["path"] == "02.mp3" and "disk on fire" in item["reason"]
    assert scanner.current_state_event()["state"] == "idle"


# ---- each file is parsed once (B21) ----


def test_embedded_art_comes_from_the_tag_pass(conn, music, scanner, monkeypatch):
    import app.artwork as artwork

    def no_second_read(*args, **kwargs):
        raise AssertionError("the audio file was opened again for artwork")

    monkeypatch.setattr(artwork, "_extract_embedded", no_second_read)
    make_mp3(music / "01.mp3", title="T", artist="A", album="X", picture=jpeg_bytes())
    make_flac(music / "02.flac", title="F", artist="A", album="Y", picture=png_bytes())
    scanner.run_scan("test")
    mimes = {
        r["path"]: r["mime"]
        for r in conn.execute(
            "SELECT t.path, a.mime FROM tracks t JOIN artwork a ON a.id = t.artwork_id"
        )
    }
    assert mimes == {"01.mp3": "image/jpeg", "02.flac": "image/png"}


# ---- symlinks (S12) ----


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_symlinks_outside_the_library_are_not_indexed(conn, music, scanner, tmp_path):
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "flow.db").write_bytes(b"SQLite format 3\x00" + b"\x00" * 4096)
    make_mp3(outside / "real.mp3", title="Outside", artist="O")
    os.symlink(outside / "flow.db", music / "x.mp3")
    os.symlink(outside / "real.mp3", music / "y.mp3")
    make_mp3(music / "inside.mp3", title="Inside", artist="I")
    os.symlink(music / "inside.mp3", music / "alias.mp3")
    scanner.run_scan("test")

    paths = {r["path"] for r in conn.execute("SELECT path FROM tracks")}
    assert paths == {"inside.mp3", "alias.mp3"}
    skipped = {i["path"] for i in scanner.scan_error_log()["items"]}
    assert skipped == {"x.mp3", "y.mp3"}
