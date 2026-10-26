"""Library read endpoints and media streaming."""

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


# ---- paging stability, full rescan, sized artwork ----


def test_pages_over_equal_sort_keys_never_repeat_or_skip(client, music):
    for i in range(12):
        make_mp3(music / "intros" / f"{i:02d}.mp3", title="Intro", artist=f"A{i % 3}")
    client.app.state.scanner.run_scan("test")

    for sort in ("title", "artist", "year"):
        for direction in ("asc", "desc"):
            seen = []
            for offset in range(0, 16, 3):
                page = client.get(
                    "/api/tracks",
                    params={"sort": sort, "dir": direction, "limit": 3, "offset": offset},
                ).json()["items"]
                seen += [t["id"] for t in page]
            assert len(seen) == len(set(seen)) == 16


def test_full_rescan_flag_reaches_the_scanner(client, library, monkeypatch):
    calls = []
    monkeypatch.setattr(
        client.app.state.scanner,
        "start_scan",
        lambda trigger, full=False: calls.append((trigger, full)) or True,
    )
    assert client.post("/api/scan").status_code == 202
    assert client.post("/api/scan", params={"full": 1}).status_code == 202
    assert calls == [("manual", False), ("manual", True)]


@pytest.fixture
def real_cover(tmp_path):
    """A decodable 600×400 JPEG (the fixture JPEGs are magic bytes only)."""
    import shutil
    import subprocess

    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    out = tmp_path / "cover.jpg"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=600x400",
         "-frames:v", "1", str(out)],
        check=True,
    )
    return out.read_bytes()


def _store(client, data: bytes) -> int:
    from app.artwork import sniff_mime, store_artwork

    conn = client.app.state.db.connect()
    artwork_id = store_artwork(conn, data, sniff_mime(data))
    conn.commit()
    return artwork_id


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """(width, height) from the first SOF marker."""
    i = 2
    while i < len(data):
        marker, length = data[i + 1], int.from_bytes(data[i + 2 : i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7 : i + 9], "big"), int.from_bytes(
                data[i + 5 : i + 7], "big"
            )
        i += 2 + length
    raise AssertionError("no SOF marker")


def test_sized_artwork_is_rendered_cached_and_bounded(
    client, library, real_cover, tmp_path, monkeypatch
):
    from app import config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    artwork_id = _store(client, real_cover)
    cache = tmp_path / "data" / "artwork-cache"

    response = client.get(f"/api/artwork/{artwork_id}", params={"s": 100})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "private" in response.headers["cache-control"]
    assert _jpeg_size(response.content) == (128, 85)  # snapped up to 128, aspect kept
    assert len(list(cache.glob(f"{artwork_id}-128-*.jpg"))) == 1

    # Cached: a second request doesn't render again.
    import app.artwork as artwork_module

    monkeypatch.setattr(artwork_module.subprocess, "run", None)
    again = client.get(f"/api/artwork/{artwork_id}", params={"s": 128})
    assert again.content == response.content
    monkeypatch.undo()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")

    # Never upscaled; huge requests snap down to the largest size.
    big = client.get(f"/api/artwork/{artwork_id}", params={"s": 4000})
    assert _jpeg_size(big.content) == (512, 341)
    # No size → the original bytes.
    assert client.get(f"/api/artwork/{artwork_id}").content == real_cover


def test_sized_artwork_cache_follows_the_content(client, library, real_cover, tmp_path, monkeypatch):
    """A reused id with new content renders afresh and replaces the old file;
    startup prune drops renders whose artwork row is gone."""
    from app import config
    from app.artwork import prune_thumbnail_cache

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    cache = tmp_path / "data" / "artwork-cache"
    artwork_id = _store(client, real_cover)
    client.get(f"/api/artwork/{artwork_id}", params={"s": 64})
    (first,) = cache.glob(f"{artwork_id}-64-*.jpg")

    conn = client.app.state.db.connect()
    conn.execute(
        "UPDATE artwork SET hash = 'abababababababababababababababababababab', blob = ? WHERE id = ?",
        (real_cover + b"\x00", artwork_id),
    )
    conn.commit()
    client.get(f"/api/artwork/{artwork_id}", params={"s": 64})
    (second,) = cache.glob(f"{artwork_id}-64-*.jpg")
    assert second != first

    (cache / "999999-64-0123456789abcdef.jpg").write_bytes(b"orphan")
    assert prune_thumbnail_cache(conn, cache) == 1
    assert sorted(cache.iterdir()) == [second]


def test_sized_artwork_falls_back_to_the_original(client, library, tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    artwork_id = next(
        t["artwork_id"] for t in client.get("/api/tracks").json()["items"] if t["artwork_id"]
    )
    # The fixture JPEG is undecodable: ffmpeg fails, the original is served.
    response = client.get(f"/api/artwork/{artwork_id}", params={"s": 64})
    assert response.status_code == 200
    assert response.content == jpeg_bytes()
    # Same when ffmpeg is missing altogether.
    import app.artwork as artwork_module

    monkeypatch.setattr(artwork_module.shutil, "which", lambda name: None)
    assert client.get(f"/api/artwork/{artwork_id}", params={"s": 64}).content == jpeg_bytes()
    assert client.get(f"/api/artwork/{artwork_id}", params={"s": 0}).status_code == 422
