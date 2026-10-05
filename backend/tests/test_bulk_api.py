"""Bulk organize API: POST /api/tracks/bulk, undo, review summary, and the
`review` filters on GET /api/tracks. All edits are SQLite overlays through
the same apply path as PATCH /api/tracks/{id} — files untouched."""

from __future__ import annotations

import os

import pytest
from tests.audio_fixtures import make_mp3


@pytest.fixture
def library(music):
    # Pump: two tracks by Aerosmith — a real album that pruning must keep.
    make_mp3(
        music / "A" / "01 - First.mp3",
        title="First", artist="Aerosmith", albumartist="Aerosmith",
        album="Pump", track="1/10", year="1989",
    )
    make_mp3(
        music / "A" / "02 - Second.mp3",
        title="Second", artist="Aerosmith", albumartist="Aerosmith",
        album="Pump", track="2/10", year="1989",
    )
    # A suffix variant of a DIFFERENT album — the collision case.
    make_mp3(
        music / "B" / "01 - Wall One.mp3",
        title="Wall One", artist="The Wall", albumartist="The Wall",
        album="The Wall", track="1/2",
    )
    make_mp3(
        music / "B" / "02 - Wall Two.mp3",
        title="Wall Two", artist="The Wall", albumartist="The Wall",
        album="The Wall (Deluxe Edition)", track="2/2",
    )
    # A loose track: no album, no track number (fallback title from filename).
    make_mp3(music / "loose.mp3", title="Loose", artist="Beta Band")
    return music


def _track(client, title: str) -> dict:
    return client.get("/api/tracks", params={"q": title}).json()["items"][0]


def _ids(client, *titles: str) -> list[int]:
    return [_track(client, t)["id"] for t in titles]


# ---- bulk apply: field semantics ----


def test_bulk_set_album_moves_tracks_and_prunes(client, library):
    first, second = _ids(client, "First", "Second")
    out = client.post(
        "/api/tracks/bulk", json={"track_ids": [first, second], "album": "Nightfall"}
    )
    assert out.status_code == 200
    assert out.json()["applied"] == 2

    albums = {a["title"]: a["track_count"] for a in client.get("/api/albums").json()["items"]}
    assert albums["Nightfall"] == 2
    assert "Pump" not in albums  # emptied by the move → pruned

    for tid in (first, second):
        moved = client.get(f"/api/tracks/{tid}").json()
        assert moved["album"] == "Nightfall"
        assert moved["artist"] == "Aerosmith"  # absent field → untouched


def test_bulk_absent_fields_untouched_and_null_clears_track_no(client, library):
    first, second = _ids(client, "First", "Second")
    # Only track_no present, explicit null: titles and artists stay.
    out = client.post(
        "/api/tracks/bulk",
        json={"track_ids": [first, second], "track_no": None},
    ).json()
    assert out["applied"] == 2
    assert client.get(f"/api/tracks/{first}").json()["track_no"] is None

    # 0 normalizes to null; absent fields still untouched.
    client.post("/api/tracks/bulk", json={"track_ids": [first], "track_no": 0})
    assert client.get(f"/api/tracks/{first}").json()["track_no"] is None
    assert client.get(f"/api/tracks/{first}").json()["title"] == "First"


def test_bulk_empty_strings_clear_references(client, library):
    first = _track(client, "First")
    out = client.post(
        "/api/tracks/bulk",
        json={"track_ids": [first["id"]], "artist": "", "album": ""},
    ).json()
    assert out["applied"] == 1
    cleared = client.get(f"/api/tracks/{first['id']}").json()
    assert cleared["artist"] is None
    assert cleared["album"] is None
    # The track now shows up in the no-album review.
    assert client.get(
        "/api/tracks", params={"review": "no_album"}
    ).json()["total"] >= 2  # Loose was already albumless


def test_bulk_empty_title_rejects_all_or_nothing(client, library):
    first, second = _ids(client, "First", "Second")
    before = client.get(f"/api/tracks/{second}").json()
    out = client.post(
        "/api/tracks/bulk",
        json={"track_ids": [first, second], "title": "   "},
    )
    assert out.status_code == 422
    # Nothing was written — not even to the track processed before the failure.
    after = client.get(f"/api/tracks/{second}").json()
    assert after == before


def test_bulk_no_changes_is_422_and_noop_apply_is_zero(client, library):
    first = _track(client, "First")
    assert client.post("/api/tracks/bulk", json={"track_ids": [first["id"]]}).status_code == 422
    # A change that matches the current value still writes (pins the overlay).
    out = client.post(
        "/api/tracks/bulk", json={"track_ids": [first["id"]], "artist": "Aerosmith"}
    ).json()
    assert out["applied"] == 1


def test_bulk_unknown_review_filter_is_422(client, library):
    out = client.post("/api/tracks/bulk", json={"review": "bogus", "title": "X"})
    assert out.status_code == 422


def test_bulk_filter_selection_with_except_ids(client, library):
    # Only the two Wall tracks match; exclude one, apply to the rest.
    wall_one, wall_two = _ids(client, "Wall One", "Wall Two")
    out = client.post(
        "/api/tracks/bulk",
        json={"q": "wall", "except_ids": [wall_two], "album": "Brickwork"},
    ).json()
    assert out["applied"] == 1
    assert client.get(f"/api/tracks/{wall_one}").json()["album"] == "Brickwork"
    assert client.get(f"/api/tracks/{wall_two}").json()["album"] == "The Wall (Deluxe Edition)"


def test_bulk_review_selection_targets_the_problem_rows(client, library):
    # review=no_album selects only the loose track.
    out = client.post(
        "/api/tracks/bulk", json={"review": "no_album", "album": "Dowry"}
    ).json()
    assert out["applied"] == 1
    loose = _track(client, "Loose")
    assert loose["album"] == "Dowry"


def test_bulk_overlay_survives_rescan(client, library):
    first = _track(client, "First")
    client.post(
        "/api/tracks/bulk",
        json={"track_ids": [first["id"]], "title": "Bulk Named", "track_no": 7},
    )
    conn = client.app.state.scanner._db.connect()
    row = conn.execute("SELECT path FROM tracks WHERE id = ?", (first["id"],)).fetchone()
    target = library / row["path"]
    st = target.stat()
    os.utime(target, (st.st_atime, st.st_mtime + 5))
    client.app.state.scanner.run_scan("test")

    after = client.get(f"/api/tracks/{first['id']}").json()
    assert after["title"] == "Bulk Named"
    assert after["track_no"] == 7


# ---- undo: one generation ----


def test_undo_restores_previous_values(client, library):
    first, second = _ids(client, "First", "Second")
    client.post(
        "/api/tracks/bulk", json={"track_ids": [first, second], "album": "Nightfall"}
    )
    assert client.get("/api/albums", params={"q": "pump"}).json()["total"] == 0

    out = client.post("/api/tracks/bulk/undo")
    assert out.status_code == 200
    assert out.json()["applied"] == 2

    for tid in (first, second):
        restored = client.get(f"/api/tracks/{tid}").json()
        assert restored["album"] == "Pump"
        assert restored["track_no"] in (1, 2)
    # The emptied Nightfall album is pruned by the undo itself.
    titles = {a["title"] for a in client.get("/api/albums").json()["items"]}
    assert "Nightfall" not in titles
    assert "Pump" in titles


def test_undo_is_one_generation_and_404_when_empty(client, library):
    first = _track(client, "First")
    assert client.post("/api/tracks/bulk/undo").status_code == 404

    client.post("/api/tracks/bulk", json={"track_ids": [first["id"]], "title": "One"})
    client.post("/api/tracks/bulk", json={"track_ids": [first["id"]], "title": "Two"})
    client.post("/api/tracks/bulk/undo")
    # Only the last generation is restorable; the second undo finds nothing.
    assert client.post("/api/tracks/bulk/undo").status_code == 404
    assert client.get(f"/api/tracks/{first['id']}").json()["title"] == "One"


def test_undo_clears_and_recreates_entities(client, library):
    first = _track(client, "First")
    client.post(
        "/api/tracks/bulk",
        json={"track_ids": [first["id"]], "artist": "", "album": ""},
    )
    assert client.get(f"/api/tracks/{first['id']}").json()["album"] is None

    client.post("/api/tracks/bulk/undo")
    restored = client.get(f"/api/tracks/{first['id']}").json()
    assert restored["album"] == "Pump"
    assert restored["artist"] == "Aerosmith"


# ---- GET /api/tracks review filters ----


def test_review_filters_on_track_list(client, library):
    assert client.get("/api/tracks", params={"review": "no_album"}).json()["total"] == 1
    # The Wall and The Wall (Deluxe Edition) each hold one track.
    assert (
        client.get("/api/tracks", params={"review": "single_track_albums"}).json()["total"]
        == 2
    )
    assert (
        client.get("/api/tracks", params={"review": "mixed_album_artist"}).json()["total"]
        == 0
    )
    assert client.get("/api/tracks", params={"review": "bogus"}).status_code == 422


def test_curate_sort_groups_albums_then_track_order(client, library):
    items = client.get("/api/tracks", params={"sort": "curate"}).json()["items"]
    # Album blocks contiguous (title, then album artist), track numbers
    # ascending within, the albumless track last.
    assert [t["title"] for t in items] == [
        "First", "Second", "Wall One", "Wall Two", "Loose",
    ]


def test_curate_sort_keeps_same_titled_albums_contiguous(client, library):
    """Two artists can each own a same-titled album (grouping keys on album
    artist) — the sort must not interleave their tracks."""
    conn = client.app.state.scanner._db.connect()
    conn.execute(
        "UPDATE albums SET title = 'Pump' WHERE title IN "
        "('The Wall', 'The Wall (Deluxe Edition)')"
    )
    conn.commit()
    items = client.get("/api/tracks", params={"sort": "curate"}).json()["items"]
    # Each artist's Pump must sit as one block, not interleaved.
    pump_titles = [t["title"] for t in items if t["album"] == "Pump"]
    assert pump_titles == ["First", "Second", "Wall One", "Wall Two"]


# ---- review summary ----


def test_review_summary_counts(client, library):
    summary = client.get("/api/review/summary").json()
    assert summary["no_album"] == 1
    assert summary["single_track_albums"] == 2
    assert summary["mixed_album_artist_albums"] == 0
    assert summary["undo_available"] is False
    # "The Wall" vs "The Wall (Deluxe Edition)" — same artist, suffix variant.
    assert summary["suffix_collisions"] == 1
    group = summary["collision_groups"][0]
    assert {a["title"] for a in group["albums"]} == {"The Wall", "The Wall (Deluxe Edition)"}


def test_review_summary_same_title_different_artists_is_not_a_collision(
    client, library
):
    make_mp3(
        library / "C" / "01 - Anthem.mp3",
        title="Anthem", artist="Rush", albumartist="Rush",
        album="Exit", track="1",
    )
    make_mp3(
        library / "D" / "01 - Hymn.mp3",
        title="Hymn", artist="Ultravox", albumartist="Ultravox",
        album="Exit (Deluxe)", track="1",
    )
    client.app.state.scanner.run_scan("add-exits")
    summary = client.get("/api/review/summary").json()
    assert summary["suffix_collisions"] == 1  # still only The Wall group


def test_review_summary_mixed_album_artist(client, library):
    """Album grouping keys on (title, album artist), so mixed state only
    arises when an album overlay pins tracks to one album row while a
    re-tagged file re-derives its album artist on rescan."""
    wall_one, wall_two = _ids(client, "Wall One", "Wall Two")
    client.post(
        "/api/tracks/bulk",
        json={"track_ids": [wall_one, wall_two], "album": "The Wall X"},
    )
    # The overlay pins both tracks to the album row; a retag re-derives one
    # track's album artist (not user-edited → follows tags).
    make_mp3(
        library / "B" / "01 - Wall One.mp3",
        title="Wall One", artist="The Wall", albumartist="Someone Else",
        album="The Wall X", track="1/2",
    )
    client.app.state.scanner.run_scan("retag-albumartist")

    summary = client.get("/api/review/summary").json()
    assert summary["mixed_album_artist_albums"] == 1
    assert (
        client.get("/api/tracks", params={"review": "mixed_album_artist"}).json()["total"]
        == 2
    )


def test_review_summary_undo_available_after_apply(client, library):
    first = _track(client, "First")
    client.post("/api/tracks/bulk", json={"track_ids": [first["id"]], "title": "Renamed"})
    assert client.get("/api/review/summary").json()["undo_available"] is True
    client.post("/api/tracks/bulk/undo")
    assert client.get("/api/review/summary").json()["undo_available"] is False
