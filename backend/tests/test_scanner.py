"""Scanner semantics: parsing, overlays, moves, removals."""

from __future__ import annotations

import os
import time

import pytest
from tests.audio_fixtures import jpeg_bytes, make_flac, make_mp3, png_bytes

from app.scanner import Edited, _utcnow


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
