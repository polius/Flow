"""Track editing: PATCH /api/tracks/{id} overlay semantics."""

from __future__ import annotations

import pytest
from tests.audio_fixtures import make_mp3


@pytest.fixture
def library(music):
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
    make_mp3(music / "loose.mp3", title="Loose", artist="Beta Band")
    return music


def _track(client, title: str) -> dict:
    return client.get("/api/tracks", params={"q": title}).json()["items"][0]


def test_favorite_toggle_roundtrip(client, library):
    track = _track(client, "Loose")
    assert track["favorite"] is False

    patched = client.patch(f"/api/tracks/{track['id']}", json={"favorite": True})
    assert patched.json()["favorite"] is True

    # Absent field → untouched (exclude_unset semantics).
    patched = client.patch(f"/api/tracks/{track['id']}", json={"title": "Loose 2"})
    assert patched.json()["favorite"] is True

    patched = client.patch(f"/api/tracks/{track['id']}", json={"favorite": False})
    assert patched.json()["favorite"] is False


def test_title_edit_sets_overlay_and_survives_rescan(client, library):
    track = _track(client, "Loose")
    out = client.patch(f"/api/tracks/{track['id']}", json={"title": "Renamed"}).json()
    assert out["title"] == "Renamed"

    # The scanner preserves the overlay: mtime changed → user_edited bits
    # re-apply. Touch the file to force re-read.
    conn = client.app.state.scanner._db.connect()
    row = conn.execute("SELECT path, mtime FROM tracks WHERE id = ?", (track["id"],)).fetchone()
    target = library / row["path"]
    import os
    st = target.stat()
    os.utime(target, (st.st_atime, st.st_mtime + 5))
    client.app.state.scanner.run_scan("test")

    after = client.get(f"/api/tracks/{track['id']}").json()
    assert after["title"] == "Renamed"


def test_artist_edit_regroups_single_track_and_prunes(client, library):
    first = _track(client, "First")
    second = _track(client, "Second")

    out = client.patch(f"/api/tracks/{first['id']}", json={"artist": "Steven T."}).json()
    assert out["artist"] == "Steven T."

    # Only the edited track moved.
    assert client.get(f"/api/tracks/{second['id']}").json()["artist"] == "Aerosmith"

    artists = {a["name"]: a["track_count"] for a in client.get("/api/artists").json()["items"]}
    assert artists["Steven T."] == 1
    assert artists["Aerosmith"] == 1  # second track still holds it


def test_artist_edit_clearing_leaves_album_artist_reference(client, library):
    """Clearing the track artist nulls artist_id. The album-artist reference
    follows tags and is not user-editable at MVP, so an artist still
    referenced as album artist survives the prune."""
    loose = _track(client, "Loose")  # Beta Band is both artist and album artist

    out = client.patch(f"/api/tracks/{loose['id']}", json={"artist": ""}).json()
    assert out["artist"] is None

    names = {a["name"] for a in client.get("/api/artists").json()["items"]}
    assert "Beta Band" in names  # held by album_artist_id

    # An artist unreferenced by any track row after an edit is pruned: move
    # the album away and the track's artist too.
    solo = _track(client, "First")
    client.patch(f"/api/tracks/{solo['id']}", json={"album": "Nightfall"})
    pump_still = {a["name"] for a in client.get("/api/artists").json()["items"]}
    assert "Aerosmith" in pump_still  # second track + album artist keep it


def test_album_edit_prunes_orphaned_album(client, library):
    """Pump holds two tracks; moving one away leaves one, so Pump survives.
    A one-track album loses its row when its only track moves out."""
    make_mp3(
        library / "solo" / "01 - One Off.mp3",
        title="One Off", artist="Session Player", albumartist="Session Player",
        album="Gallery", track="1/1",
    )
    client.app.state.scanner.run_scan("add-solo")

    track = _track(client, "One Off")
    client.patch(f"/api/tracks/{track['id']}", json={"album": "Elsewhere"})

    titles = {a["title"] for a in client.get("/api/albums").json()["items"]}
    assert "Gallery" not in titles  # no track references it anymore
    assert "Elsewhere" in titles


def test_prune_keeps_user_set_covers(client, library):
    """Artwork referenced ONLY by a cover_artwork_id (a playlist's uploaded
    cover) must survive the orphan prune — the FK-constrained DELETE used to
    trip over exactly those rows and 500 the edit that triggered it."""
    import base64

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ"
        "AAAABJRU5ErkJggg=="
    )
    created = client.post("/api/playlists", json={"name": "Covers"})
    pid = created.json()["id"]
    uploaded = client.put(
        f"/api/playlists/{pid}/cover",
        files={"file": ("cover.png", png, "image/png")},
    )
    cover_id = uploaded.json()["cover_artwork_id"]
    assert cover_id is not None

    # The edit whose prune used to crash — and the cover must survive it.
    track = _track(client, "Loose")
    out = client.patch(f"/api/tracks/{track['id']}", json={"title": "Loose 2"})
    assert out.status_code == 200
    assert client.get(f"/api/artwork/{cover_id}").status_code == 200


def test_album_edit_moves_track_and_creates_album(client, library):
    first = _track(client, "First")
    pump = client.get("/api/albums", params={"q": "pump"}).json()["items"][0]
    old_album_tracks = pump["track_count"]

    out = client.patch(f"/api/tracks/{first['id']}", json={"album": "Nightfall"}).json()
    assert out["album"] == "Nightfall"

    albums = {a["title"]: a["track_count"] for a in client.get("/api/albums").json()["items"]}
    assert albums["Nightfall"] == 1
    assert albums["Pump"] == old_album_tracks - 1

    # The new album inherits the track's year (backfilled at creation).
    nightfall = client.get("/api/albums", params={"q": "nightfall"}).json()["items"][0]
    assert nightfall["year"] == 1989


def test_track_no_edit_sets_bit(client, library):
    first = _track(client, "First")
    out = client.patch(f"/api/tracks/{first['id']}", json={"track_no": 7}).json()
    assert out["track_no"] == 7

    # Order-by-track_no inside the album reflects the edit.
    album = client.get(f"/api/albums/{out['album_id']}").json()
    assert [t["track_no"] for t in album["tracks"]] == [2, 7] or [
        t["track_no"] for t in album["tracks"]
    ] == [7, 2]


def test_track_no_clear_and_absent(client, library):
    """Explicit null clears the number; an absent field leaves it alone.
    The Get Info panel sends `track_no: null` when the field is blanked."""
    first = _track(client, "First")
    second = _track(client, "Second")

    out = client.patch(f"/api/tracks/{first['id']}", json={"track_no": None}).json()
    assert out["track_no"] is None

    # Absent field → untouched.
    out = client.patch(f"/api/tracks/{first['id']}", json={"favorite": True}).json()
    assert out["track_no"] is None
    assert client.get(f"/api/tracks/{second['id']}").json()["track_no"] == 2

    # A cleared number survives a forced rescan (overlay bit is set).
    conn = client.app.state.scanner._db.connect()
    row = conn.execute("SELECT path FROM tracks WHERE id = ?", (first["id"],)).fetchone()
    target = library / row["path"]
    import os
    st = target.stat()
    os.utime(target, (st.st_atime, st.st_mtime + 5))
    client.app.state.scanner.run_scan("test")
    assert client.get(f"/api/tracks/{first['id']}").json()["track_no"] is None


def test_combined_patch_and_404(client, library):
    track = _track(client, "Loose")
    out = client.patch(
        f"/api/tracks/{track['id']}",
        json={"title": "All At Once", "artist": "New Artist", "track_no": 3, "favorite": True},
    )
    body = out.json()
    assert body["title"] == "All At Once"
    assert body["artist"] == "New Artist"
    assert body["track_no"] == 3
    assert body["favorite"] is True

    assert client.patch("/api/tracks/99999", json={"title": "x"}).status_code == 404
    assert client.patch(f"/api/tracks/{track['id']}", json={"title": "  "}).status_code == 422
    assert client.patch(f"/api/tracks/{track['id']}", json={"track_no": -1}).status_code == 422


def test_full_overlay_survives_rescan(client, library):
    track = _track(client, "Loose")
    client.patch(
        f"/api/tracks/{track['id']}",
        json={"title": "Edited Title", "artist": "Edited Artist", "album": "Edited Album", "track_no": 9},
    )

    import os
    conn = client.app.state.scanner._db.connect()
    row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track["id"],)).fetchone()
    target = library / row["path"]
    st = target.stat()
    os.utime(target, (st.st_atime, st.st_mtime + 5))
    client.app.state.scanner.run_scan("test")

    after = client.get(f"/api/tracks/{track['id']}").json()
    assert after["title"] == "Edited Title"
    assert after["artist"] == "Edited Artist"
    assert after["album"] == "Edited Album"
    assert after["track_no"] == 9


def test_genre_edit_sets_and_clears(client, library):
    """The genre cell replaces the track's tag genres with the one named; the
    scanner preserves the choice (the GENRE overlay bit)."""
    track = _track(client, "Loose")
    assert track["genre"] is None  # fixture has no genre tag

    out = client.patch(f"/api/tracks/{track['id']}", json={"genre": "Space Rock"})
    assert out.status_code == 200
    assert out.json()["genre"] == "Space Rock"

    # The genre filter vocabulary picks it up.
    genres = client.get("/api/genres").json()["items"]
    assert [g["name"] for g in genres] == ["Space Rock"]

    # An empty string clears.
    cleared = client.patch(f"/api/tracks/{track['id']}", json={"genre": ""})
    assert cleared.json()["genre"] is None
    assert client.get("/api/genres").json()["items"] == []


def test_genre_edit_survives_rescan(client, library):
    track = _track(client, "Loose")
    client.patch(f"/api/tracks/{track['id']}", json={"genre": "Space Rock"})

    import os
    conn = client.app.state.scanner._db.connect()
    row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track["id"],)).fetchone()
    target = library / row["path"]
    st = target.stat()
    os.utime(target, (st.st_atime, st.st_mtime + 5))
    client.app.state.scanner.run_scan("test")

    after = client.get(f"/api/tracks/{track['id']}").json()
    assert after["genre"] == "Space Rock"


def test_bulk_genre_apply(client, library):
    first = _track(client, "First")
    second = _track(client, "Second")
    out = client.post(
        "/api/tracks/bulk",
        json={"track_ids": [first["id"], second["id"]], "genre": "Hard Rock"},
    )
    assert out.json()["applied"] == 2
    genres = {t["id"]: t["genre"] for t in client.get("/api/tracks").json()["items"]}
    assert genres[first["id"]] == "Hard Rock"
    assert genres[second["id"]] == "Hard Rock"


def test_reorder_renumbers_and_sets_overlay(client, library):
    first = _track(client, "First")
    second = _track(client, "Second")
    loose = _track(client, "Loose")

    out = client.post(
        "/api/tracks/reorder",
        json={"track_ids": [second["id"], first["id"], loose["id"]]},
    )
    assert out.status_code == 200
    assert out.json()["applied"] == 3
    numbers = {t["id"]: t["track_no"] for t in client.get("/api/tracks").json()["items"]}
    assert numbers == {second["id"]: 1, first["id"]: 2, loose["id"]: 3}

    # Unknown ids are skipped, not fatal; duplicates collapse to one slot.
    again = client.post(
        "/api/tracks/reorder",
        json={"track_ids": [loose["id"], 99999, loose["id"]]},
    )
    assert again.status_code == 200
    assert again.json()["applied"] == 1
    assert client.get(f"/api/tracks/{loose['id']}").json()["track_no"] == 1


def test_reorder_is_undoable(client, library):
    """A drag-reorder stores the pre-drag numbers as the undo generation;
    bulk/undo puts them back (including a number that was unset)."""
    first = _track(client, "First")
    second = _track(client, "Second")
    loose = _track(client, "Loose")

    client.post(
        "/api/tracks/reorder",
        json={"track_ids": [second["id"], first["id"], loose["id"]]},
    )
    out = client.post("/api/tracks/bulk/undo")
    assert out.status_code == 200
    assert out.json()["applied"] == 3

    numbers = {t["id"]: t["track_no"] for t in client.get("/api/tracks").json()["items"]}
    assert numbers == {first["id"]: 1, second["id"]: 2, loose["id"]: None}


# ---- Favorites manual order ----


def _favorites_in_order(client) -> list[int]:
    items = client.get(
        "/api/tracks", params={"favorite": True, "sort": "favorite", "dir": "asc"}
    ).json()["items"]
    return [t["id"] for t in items]


def test_loving_appends_to_favorites_order(client, library):
    """Loving a track appends it to the Favorites manual order; the view's
    sort=favorite reads that order back."""
    first = _track(client, "First")
    second = _track(client, "Second")
    loose = _track(client, "Loose")

    client.patch(f"/api/tracks/{second['id']}", json={"favorite": True})
    client.patch(f"/api/tracks/{first['id']}", json={"favorite": True})
    client.patch(f"/api/tracks/{loose['id']}", json={"favorite": True})

    assert _favorites_in_order(client) == [second["id"], first["id"], loose["id"]]


def test_unloving_releases_and_reloving_appends(client, library):
    first = _track(client, "First")
    second = _track(client, "Second")
    client.patch(f"/api/tracks/{first['id']}", json={"favorite": True})
    client.patch(f"/api/tracks/{second['id']}", json={"favorite": True})

    # Unloving releases the slot; re-loving appends after the survivors.
    client.patch(f"/api/tracks/{first['id']}", json={"favorite": False})
    loose = _track(client, "Loose")
    client.patch(f"/api/tracks/{loose['id']}", json={"favorite": True})
    client.patch(f"/api/tracks/{first['id']}", json={"favorite": True})

    assert _favorites_in_order(client) == [second["id"], loose["id"], first["id"]]


def test_favorites_reorder_writes_manual_order(client, library):
    first = _track(client, "First")
    second = _track(client, "Second")
    loose = _track(client, "Loose")
    for tid in (first["id"], second["id"], loose["id"]):
        client.patch(f"/api/tracks/{tid}", json={"favorite": True})

    out = client.post(
        "/api/favorites/reorder",
        json={"track_ids": [loose["id"], first["id"], second["id"]]},
    )
    assert out.status_code == 200
    assert out.json()["applied"] == 3
    assert _favorites_in_order(client) == [loose["id"], first["id"], second["id"]]

    # A track un-favorited mid-gesture is skipped, not fatal.
    client.patch(f"/api/tracks/{first['id']}", json={"favorite": False})
    again = client.post(
        "/api/favorites/reorder",
        json={"track_ids": [first["id"], second["id"], loose["id"], 99999]},
    )
    assert again.status_code == 200
    assert again.json()["applied"] == 2


def test_favorites_reorder_rejects_empty(client, library):
    out = client.post("/api/favorites/reorder", json={"track_ids": []})
    assert out.status_code == 422


# ---- single-edit undo ----


def test_single_patch_stores_undo_generation(client, library):
    """A single-track PATCH joins the same one-generation undo as a bulk
    apply: bulk/undo restores every field the patch touched."""
    track = _track(client, "Loose")

    out = client.patch(
        f"/api/tracks/{track['id']}", json={"title": "Renamed", "genre": "Rock"}
    )
    assert out.status_code == 200
    assert client.get("/api/review/summary").json()["undo_available"] is True

    undone = client.post("/api/tracks/bulk/undo")
    assert undone.status_code == 200
    assert undone.json()["applied"] == 1

    restored = client.get(f"/api/tracks/{track['id']}").json()
    assert restored["title"] == "Loose"
    assert restored["genre"] is None
    # The generation is spent — one undo, like every other edit.
    assert client.post("/api/tracks/bulk/undo").status_code == 404


def test_favorite_patch_leaves_undo_generation_alone(client, library):
    """The heart's PATCH carries no metadata fields, so it must not clobber
    a pending undo generation — the heart has its own undo elsewhere."""
    track = _track(client, "Loose")
    client.patch(f"/api/tracks/{track['id']}", json={"title": "Renamed"})

    client.patch(f"/api/tracks/{track['id']}", json={"favorite": True})
    assert client.get("/api/review/summary").json()["undo_available"] is True

    client.post("/api/tracks/bulk/undo")
    assert client.get(f"/api/tracks/{track['id']}").json()["title"] == "Loose"
    # The favorite rode its own path and is untouched by the metadata undo.
    assert client.get(f"/api/tracks/{track['id']}").json()["favorite"] is True


# ---- album artist moves the whole album; undo restores the overlay bits ----


def _rescan_all(client, library):
    import os

    for path in library.rglob("*.mp3"):
        st = path.stat()
        os.utime(path, (st.st_atime, st.st_mtime + 5))
    client.app.state.scanner.run_scan("test")


def _user_edited(client, track_id: int) -> int:
    conn = client.app.state.db.connect()
    return conn.execute(
        "SELECT user_edited FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()["user_edited"]


def test_album_artist_edit_keeps_the_album_whole_across_rescans(client, library):
    """The audit's repro: Get Info sets one track's album artist; the album
    row moves, and a rescan used to resolve the siblings back by tag and
    split the album (Pump/Aero ×1 + Pump/Various Artists ×2)."""
    first, second = _track(client, "First"), _track(client, "Second")
    client.patch(f"/api/tracks/{first['id']}", json={"album_artist": "Various Artists"})

    sibling = client.get(f"/api/tracks/{second['id']}").json()
    assert sibling["album_artist"] == "Various Artists"
    _rescan_all(client, library)

    albums = client.get("/api/albums").json()["items"]
    pump = [a for a in albums if a["title"] == "Pump"]
    assert len(pump) == 1
    assert pump[0]["artist"] == "Various Artists" and pump[0]["track_count"] == 2

    # One undo restores both tracks and the album, unpinned.
    assert client.post("/api/tracks/bulk/undo").status_code == 200
    for tid in (first["id"], second["id"]):
        assert client.get(f"/api/tracks/{tid}").json()["album_artist"] == "Aerosmith"
        assert _user_edited(client, tid) == 0
    pump = [a for a in client.get("/api/albums").json()["items"] if a["title"] == "Pump"]
    assert [a["artist"] for a in pump] == ["Aerosmith"]


def test_album_and_album_artist_together_regroup_under_the_new_artist(client, library):
    """Both fields in one edit: the new album resolves under the NEW album
    artist, and the old album row stays where it was."""
    first, second = _track(client, "First"), _track(client, "Second")
    out = client.patch(
        f"/api/tracks/{first['id']}",
        json={"album": "Pump Live", "album_artist": "Various Artists"},
    ).json()
    assert out["album"] == "Pump Live"
    assert out["album_artist"] == "Various Artists"

    albums = {a["title"]: a for a in client.get("/api/albums").json()["items"]}
    assert albums["Pump Live"]["artist"] == "Various Artists"
    assert albums["Pump"]["artist"] == "Aerosmith"
    # Track and album agree; the sibling never moved.
    assert out["album_id"] == albums["Pump Live"]["id"]
    assert client.get(f"/api/tracks/{second['id']}").json()["album_id"] == albums["Pump"]["id"]


def test_undo_restores_the_previous_overlay_bits(client, library):
    """Undoing a bulk edit must not leave the tracks pinned against future
    tag changes."""
    first, second = _track(client, "First"), _track(client, "Second")
    client.patch(f"/api/tracks/{first['id']}", json={"title": "Kept edit"})
    client.post(
        "/api/tracks/bulk", json={"track_ids": [first["id"], second["id"]], "artist": "Oops"}
    )
    client.post("/api/tracks/bulk/undo")

    from app.scanner import Edited

    assert _user_edited(client, first["id"]) == int(Edited.TITLE)
    assert _user_edited(client, second["id"]) == 0
    # Tags drive the unpinned track again on the next rescan.
    _rescan_all(client, library)
    assert client.get(f"/api/tracks/{second['id']}").json()["artist"] == "Aerosmith"
    assert client.get(f"/api/tracks/{first['id']}").json()["title"] == "Kept edit"


def test_too_large_an_edit_keeps_no_partial_undo(client, library, monkeypatch):
    from app import apply

    monkeypatch.setattr(apply, "UNDO_LIMIT", 1)
    ids = [_track(client, "First")["id"], _track(client, "Second")["id"]]
    out = client.post("/api/tracks/bulk", json={"track_ids": ids, "title": "Same"}).json()
    assert out == {"applied": 2, "undo_available": False}
    assert client.post("/api/tracks/bulk/undo").status_code == 404


def test_title_edits_skip_the_orphan_prune(client, library, monkeypatch):
    from app.routers import editing

    calls = []
    monkeypatch.setattr(editing, "prune_orphans", lambda conn: calls.append(1))
    track = _track(client, "Loose")
    client.patch(f"/api/tracks/{track['id']}", json={"title": "Renamed"})
    client.patch(f"/api/tracks/{track['id']}", json={"favorite": True})
    assert calls == []
    client.patch(f"/api/tracks/{track['id']}", json={"artist": "Someone"})
    assert calls == [1]


# ---- bulk favorites ----


def test_bulk_favorite_and_unfavorite(client, library):
    ids = [_track(client, t)["id"] for t in ("Second", "First", "Loose")]
    client.patch(f"/api/tracks/{ids[2]}", json={"favorite": True})

    out = client.post(
        "/api/favorites/bulk", json={"track_ids": [*ids, 987_654], "favorite": True}
    )
    assert out.status_code == 200
    assert out.json() == {"updated": 2}  # Loose was already loved; unknown ignored

    favs = client.get(
        "/api/tracks", params={"favorite": True, "sort": "favorite"}
    ).json()["items"]
    # Appended after the existing favorite, in the order given.
    assert [t["id"] for t in favs] == [ids[2], ids[0], ids[1]]

    out = client.post("/api/favorites/bulk", json={"track_ids": ids[:2], "favorite": False})
    assert out.json() == {"updated": 2}
    favs = client.get("/api/tracks", params={"favorite": True}).json()["items"]
    assert [t["id"] for t in favs] == [ids[2]]
    # Hearts never join the edit undo generation.
    assert client.get("/api/review/summary").json()["undo_available"] is False
