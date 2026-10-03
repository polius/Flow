"""Playlist CRUD, membership, ordering, and covers."""

from __future__ import annotations

import base64

import pytest
from tests.audio_fixtures import make_mp3

# 1×1 PNG, for cover uploads.
PNG_1X1 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ"
    "AAAABJRU5ErkJggg=="
)


@pytest.fixture
def library(music):
    for i, title in enumerate(["Alpha", "Bravo", "Charlie", "Delta"], start=1):
        make_mp3(
            music / f"track{i}.mp3",
            title=title, artist="Artist", album="Album",
        )
    return music


def _tracks(client) -> list[dict]:
    return client.get("/api/tracks").json()["items"]


def test_playlist_crud_roundtrip(client, library):
    created = client.post(
        "/api/playlists", json={"name": "  Evening Drive  ", "description": "windows down"}
    )
    assert created.status_code == 201
    body = created.json()
    pid = body["id"]
    assert body["name"] == "Evening Drive"  # trimmed
    assert body["track_count"] == 0
    assert body["duration_total"] == 0
    assert body["tracks"] == []

    # No uniqueness constraint: names may repeat.
    renamed = client.patch(f"/api/playlists/{pid}", json={"name": "Night Drive"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Night Drive"

    described = client.patch(f"/api/playlists/{pid}", json={"description": None})
    assert described.status_code == 200
    assert described.json()["description"] is None

    listing = client.get("/api/playlists").json()
    assert listing["total"] == 1
    assert listing["items"][0]["name"] == "Night Drive"

    assert client.delete(f"/api/playlists/{pid}").status_code == 204
    assert client.get("/api/playlists").json()["total"] == 0
    assert client.get(f"/api/playlists/{pid}").status_code == 404


def test_playlist_create_rejects_blank_name(client, library):
    assert client.post("/api/playlists", json={"name": "   "}).status_code == 422
    assert client.post("/api/playlists", json={"name": "ok"}).status_code == 201


def test_add_remove_tracks_and_positions(client, library):
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]
    tracks = _tracks(client)
    ids = [t["id"] for t in tracks]

    added = client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": ids[:3]})
    assert added.status_code == 201
    body = added.json()
    assert [t["position"] for t in body["tracks"]] == [1, 2, 3]
    assert [t["id"] for t in body["tracks"]] == ids[:3]
    assert body["track_count"] == 3
    assert body["duration_total"] == pytest.approx(
        sum(t["duration"] for t in body["tracks"])
    )

    # Appends continue the position sequence. (Re-adding ids[0] would be a
    # set-like no-op — never twice in one playlist.)
    again = client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": [ids[3]]})
    assert again.json()["tracks"][-1]["position"] == 4

    # Removal takes out every occurrence and resequences.
    removed = client.delete(f"/api/playlists/{pid}/tracks/{ids[0]}")
    assert removed.status_code == 200
    remaining = removed.json()["tracks"]
    assert [t["position"] for t in remaining] == [1, 2, 3]
    assert [t["title"] for t in remaining] == ["Bravo", "Charlie", "Delta"]

    assert client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": [99999]}).status_code == 422
    assert client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": []}).status_code == 422
    assert client.post("/api/playlists/99999/tracks", json={"track_ids": ids[:1]}).status_code == 404


def test_reorder_requires_permutation_of_membership(client, library):
    pid = client.post("/api/playlists", json={"name": "Order"}).json()["id"]
    ids = [t["id"] for t in _tracks(client)]
    client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": ids[:3]})

    bad = client.put(f"/api/playlists/{pid}/order", json={"track_ids": ids[:2]})
    assert bad.status_code == 422

    bad_dupes = client.put(
        f"/api/playlists/{pid}/order", json={"track_ids": [ids[0], ids[0], ids[1]]}
    )
    assert bad_dupes.status_code == 422

    ok = client.put(
        f"/api/playlists/{pid}/order", json={"track_ids": [ids[2], ids[0], ids[1]]}
    )
    assert ok.status_code == 200
    assert [t["title"] for t in ok.json()["tracks"]] == ["Charlie", "Alpha", "Bravo"]


def test_duplicate_tracks_are_skipped_set_like_membership(client, library):
    """The same track may live in many playlists but never twice in one —
    add is set-like, deduping the request and skipping what the playlist
    already holds."""
    pid = client.post("/api/playlists", json={"name": "Repeats"}).json()["id"]
    ids = [t["id"] for t in _tracks(client)]
    added = client.post(
        f"/api/playlists/{pid}/tracks", json={"track_ids": [ids[0], ids[1], ids[0]]}
    )
    assert added.status_code == 201
    assert added.headers["x-tracks-added"] == "2"
    assert added.headers["x-tracks-skipped"] == "1"
    assert [t["id"] for t in added.json()["tracks"]] == [ids[0], ids[1]]

    # Re-adding an existing track adds nothing — and the playlist is honest.
    again = client.post(
        f"/api/playlists/{pid}/tracks", json={"track_ids": [ids[1], ids[2]]}
    )
    assert again.headers["x-tracks-added"] == "1"
    assert again.headers["x-tracks-skipped"] == "1"
    assert [t["id"] for t in again.json()["tracks"]] == [ids[0], ids[1], ids[2]]

    # Reorder still accepts the (now duplicate-free) membership.
    shuffled = client.put(
        f"/api/playlists/{pid}/order", json={"track_ids": [ids[2], ids[0], ids[1]]}
    )
    assert shuffled.status_code == 200


def test_mosaic_artwork_ids_follow_playlist_order(client, library):
    pid = client.post("/api/playlists", json={"name": "Covers"}).json()["id"]
    tracks = _tracks(client)
    client.post(
        f"/api/playlists/{pid}/tracks",
        json={"track_ids": [t["id"] for t in tracks]},
    )
    listing = client.get("/api/playlists").json()["items"][0]
    assert listing["artwork_ids"] == []  # no embedded art in these fixtures

    detail = client.get(f"/api/playlists/{pid}").json()
    assert detail["track_count"] == len(tracks)


def test_track_deletion_cascades_out_of_playlists(client, library):
    pid = client.post("/api/playlists", json={"name": "Cascades"}).json()["id"]
    tracks = _tracks(client)
    victim, keep = tracks[0], tracks[1]
    client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": [victim["id"], keep["id"]]})

    conn = client.app.state.scanner._db.connect()
    conn.execute("DELETE FROM tracks WHERE id = ?", (victim["id"],))
    conn.commit()

    detail = client.get(f"/api/playlists/{pid}").json()
    assert [t["id"] for t in detail["tracks"]] == [keep["id"]]
    # FK cascade leaves position gaps behind; order is still stable and the
    # client's full-reorder PUT (multiset of ids) is unaffected.
    positions = [t["position"] for t in detail["tracks"]]
    assert positions == sorted(positions)


def test_playlist_cover_upload_reset_and_validation(client, library):
    pid = client.post("/api/playlists", json={"name": "Covers"}).json()["id"]
    assert client.get(f"/api/playlists/{pid}").json()["cover_artwork_id"] is None

    png = base64.b64decode(PNG_1X1)
    uploaded = client.put(
        f"/api/playlists/{pid}/cover",
        files={"file": ("cover.png", png, "image/png")},
    )
    assert uploaded.status_code == 200
    cover_id = uploaded.json()["cover_artwork_id"]
    assert cover_id is not None

    # Served bytes are the uploaded bytes, content-addressed.
    art = client.get(f"/api/artwork/{cover_id}")
    assert art.status_code == 200
    assert art.content == png
    assert art.headers["content-type"] == "image/png"

    # Re-uploading identical bytes dedupes to the same artwork row.
    again = client.put(
        f"/api/playlists/{pid}/cover", files={"file": ("again.png", png, "image/png")}
    )
    assert again.json()["cover_artwork_id"] == cover_id

    # PATCH null resets the custom cover back to the track mosaic.
    reset = client.patch(f"/api/playlists/{pid}", json={"cover_artwork_id": None})
    assert reset.status_code == 200
    assert reset.json()["cover_artwork_id"] is None

    assert (
        client.put(
            f"/api/playlists/{pid}/cover",
            files={"file": ("x.png", b"not-an-image", "image/png")},
        ).status_code
        == 415
    )
    assert (
        client.patch(f"/api/playlists/{pid}", json={"cover_artwork_id": 99999}).status_code
        == 422
    )
    assert (
        client.put(
            "/api/playlists/99999/cover", files={"file": ("c.png", png, "image/png")}
        ).status_code
        == 404
    )
