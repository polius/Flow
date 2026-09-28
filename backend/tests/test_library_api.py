"""Library read endpoints and media streaming — DESIGN.md §6, §13.1."""

from __future__ import annotations

import pytest
from tests.audio_fixtures import jpeg_bytes, make_flac, make_mp3


@pytest.fixture
def library(music):
    make_mp3(
        music / "Aerosmith" / "Pump" / "02 - F.I.N.E..mp3",
        title="F.I.N.E.", artist="Aerosmith", albumartist="Aerosmith",
        album="Pump", track="2/10", year="1989",
    )
    make_mp3(
        music / "Aerosmith" / "Pump" / "01 - Young Lust.mp3",
        title="Young Lust", artist="Aerosmith", albumartist="Aerosmith",
        album="Pump", track="1/10", year="1989", picture=jpeg_bytes(),
    )
    make_mp3(music / "loose.mp3", title="Zebra Coup", artist="Beta Band")
    make_flac(
        music / "Muse" / "Origin" / "01 - New Born.flac",
        title="New Born", artist="Muse", album="Origin",
    )
    return music


def test_tracks_list_joins_and_sorts(client, library):
    data = client.get("/api/tracks").json()
    assert data["total"] == 4
    assert [t["title"] for t in data["items"]] == [
        "F.I.N.E.", "New Born", "Young Lust", "Zebra Coup",
    ]
    first = data["items"][0]
    assert first["artist"] == "Aerosmith"
    assert first["album"] == "Pump"
    assert first["track_no"] == 2
    assert first["favorite"] is False
    assert first["duration"] > 0


def test_tracks_search_and_filters(client, library):
    data = client.get("/api/tracks", params={"q": "lust"}).json()
    assert [t["title"] for t in data["items"]] == ["Young Lust"]

    album_id = client.get("/api/tracks", params={"q": "lust"}).json()["items"][0]["album_id"]
    data = client.get("/api/tracks", params={"album_id": album_id, "sort": "track_no"}).json()
    assert [t["track_no"] for t in data["items"]] == [1, 2]

    artist_id = client.get("/api/artists", params={"q": "muse"}).json()["items"][0]["id"]
    data = client.get("/api/tracks", params={"artist_id": artist_id}).json()
    assert [t["title"] for t in data["items"]] == ["New Born"]


def test_tracks_pagination(client, library):
    full = client.get("/api/tracks", params={"limit": 2}).json()
    assert full["total"] == 4 and len(full["items"]) == 2
    page2 = client.get("/api/tracks", params={"limit": 2, "offset": 2}).json()
    assert len(page2["items"]) == 2
    assert full["items"][0]["id"] != page2["items"][0]["id"]


def test_albums_list_and_detail(client, library):
    albums = client.get("/api/albums").json()
    assert albums["total"] == 2
    pump = next(a for a in albums["items"] if a["title"] == "Pump")
    assert pump["artist"] == "Aerosmith"
    assert pump["track_count"] == 2
    assert pump["artwork_id"] is not None  # embedded cover backfilled

    detail = client.get(f"/api/albums/{pump['id']}").json()
    assert [t["track_no"] for t in detail["tracks"]] == [1, 2]
    assert detail["duration_total"] == pytest.approx(
        sum(t["duration"] for t in detail["tracks"])
    )

    missing = client.get("/api/albums/99999")
    assert missing.status_code == 404


def test_artists_list_and_detail(client, library):
    artists = client.get("/api/artists").json()
    assert artists["total"] == 3
    muse = next(a for a in artists["items"] if a["name"] == "Muse")
    assert muse["album_count"] == 1 and muse["track_count"] == 1

    detail = client.get(f"/api/artists/{muse['id']}").json()
    assert [a["title"] for a in detail["albums"]] == ["Origin"]
    assert [t["title"] for t in detail["tracks"]] == ["New Born"]


def test_artwork_endpoint_cache_headers(client, library):
    tracks = client.get("/api/tracks").json()["items"]
    artwork_id = next(t["artwork_id"] for t in tracks if t["artwork_id"])
    response = client.get(f"/api/artwork/{artwork_id}")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert "immutable" in response.headers["cache-control"]

    assert client.get("/api/artwork/99999").status_code == 404


def test_stream_direct_mode_ranges(client, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "STREAM_MODE", "direct")
    track = client.get("/api/tracks", params={"q": "young"}).json()["items"][0]

    full = client.get(f"/api/stream/{track['id']}")
    assert full.status_code == 200
    assert full.headers["content-type"].startswith("audio/mpeg")
    size = len(full.content)

    ranged = client.get(f"/api/stream/{track['id']}", headers={"Range": "bytes=0-99"})
    assert ranged.status_code == 206
    assert len(ranged.content) == 100
    assert ranged.headers["content-range"] == f"bytes 0-99/{size}"

    tail = client.get(f"/api/stream/{track['id']}", headers={"Range": f"bytes={size - 10}-"})
    assert tail.status_code == 206
    assert len(tail.content) == 10


def test_stream_nginx_mode_x_accel(client, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "STREAM_MODE", "nginx")
    track = client.get("/api/tracks", params={"q": "young"}).json()["items"][0]
    response = client.get(f"/api/stream/{track['id']}")
    assert response.status_code == 200
    assert response.headers["x-accel-redirect"].startswith("/music-internal/")
    assert "%281989%29" in response.headers["x-accel-redirect"] or "Young" in response.headers["x-accel-redirect"]
    assert response.headers["accept-ranges"] == "bytes"


def test_stream_missing_file_is_404(client, library):
    track = client.get("/api/tracks", params={"q": "zebra"}).json()["items"][0]
    (library / "loose.mp3").unlink()
    response = client.get(f"/api/stream/{track['id']}")
    assert response.status_code == 404
