"""Album/artist cover upload + reset — the playlist cover contract (§13.10)
extended to library entities (2026-10-03): a user-set `cover_artwork_id`
overrides the scan-derived artwork while set, and DELETE restores it."""

from __future__ import annotations

import base64

import pytest
from tests.audio_fixtures import jpeg_bytes, make_mp3

# 1×1 PNG, for cover uploads.
PNG_1X1 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ"
    "AAAABJRU5ErkJggg=="
)


@pytest.fixture
def library(music):
    for i, title in enumerate(["Alpha", "Bravo", "Charlie"], start=1):
        make_mp3(
            music / f"track{i}.mp3",
            title=title, artist="Artist", album="Album",
            picture=jpeg_bytes(),  # embedded art → derived artwork_id
        )
    return music


def test_album_cover_upload_reset_and_validation(client, library):
    """The album's cover round-trip: derived art by default, PUT overrides,
    DELETE restores, and the 4xx contract matches the playlist endpoint's."""
    album_id = client.get("/api/albums").json()["items"][0]["id"]
    derived = client.get(f"/api/albums/{album_id}").json()["artwork_id"]
    assert derived is not None  # the scan extracted the embedded cover

    png = base64.b64decode(PNG_1X1)
    uploaded = client.put(
        f"/api/albums/{album_id}/cover",
        files={"file": ("cover.png", png, "image/png")},
    )
    assert uploaded.status_code == 200
    cover_id = uploaded.json()["cover_artwork_id"]
    assert cover_id is not None and cover_id != derived

    # Served bytes are the uploaded bytes, content-addressed.
    art = client.get(f"/api/artwork/{cover_id}")
    assert art.status_code == 200
    assert art.content == png
    assert art.headers["content-type"] == "image/png"

    # The list and search read the same override (one column pair everywhere).
    listed = client.get("/api/albums").json()["items"][0]["cover_artwork_id"]
    assert listed == cover_id
    searched = client.get("/api/search", params={"q": "Album"}).json()["albums"][0][
        "cover_artwork_id"
    ]
    assert searched == cover_id

    # Re-uploading identical bytes dedupes to the same artwork row.
    again = client.put(
        f"/api/albums/{album_id}/cover", files={"file": ("again.png", png, "image/png")}
    )
    assert again.json()["cover_artwork_id"] == cover_id

    # DELETE resets to the derived artwork.
    reset = client.delete(f"/api/albums/{album_id}/cover")
    assert reset.status_code == 200
    assert reset.json()["cover_artwork_id"] is None
    assert reset.json()["artwork_id"] == derived

    # PATCH re-points the cover at an existing artwork row — removal's
    # undo path — and PATCH null clears it, same as DELETE.
    restored = client.patch(
        f"/api/albums/{album_id}", json={"cover_artwork_id": cover_id}
    )
    assert restored.status_code == 200
    assert restored.json()["cover_artwork_id"] == cover_id
    cleared = client.patch(f"/api/albums/{album_id}", json={"cover_artwork_id": None})
    assert cleared.status_code == 200
    assert cleared.json()["cover_artwork_id"] is None
    assert (
        client.patch(f"/api/albums/{album_id}", json={"cover_artwork_id": 99999}).status_code
        == 422
    )

    assert (
        client.put(
            f"/api/albums/{album_id}/cover",
            files={"file": ("x.png", b"not-an-image", "image/png")},
        ).status_code
        == 415
    )
    assert (
        client.put(
            f"/api/albums/{album_id}/cover",
            files={"file": ("empty.png", b"", "image/png")},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/albums/99999/cover", files={"file": ("c.png", png, "image/png")}
        ).status_code
        == 404
    )
    assert client.delete("/api/albums/99999/cover").status_code == 404


def test_artist_cover_upload_reset_and_validation(client, library):
    """The artist's portrait round-trip: latest-album cover by default, PUT
    overrides, DELETE restores the derived stand-in."""
    artist_id = client.get("/api/artists").json()["items"][0]["id"]
    derived = client.get(f"/api/artists/{artist_id}").json()["artwork_id"]
    assert derived is not None

    png = base64.b64decode(PNG_1X1)
    uploaded = client.put(
        f"/api/artists/{artist_id}/cover",
        files={"file": ("portrait.png", png, "image/png")},
    )
    assert uploaded.status_code == 200
    cover_id = uploaded.json()["cover_artwork_id"]
    assert cover_id is not None and cover_id != derived

    # The artists grid reads the same override.
    listed = client.get("/api/artists").json()["items"][0]["cover_artwork_id"]
    assert listed == cover_id
    searched = client.get("/api/search", params={"q": "Artist"}).json()["artists"][0][
        "cover_artwork_id"
    ]
    assert searched == cover_id

    reset = client.delete(f"/api/artists/{artist_id}/cover")
    assert reset.status_code == 200
    assert reset.json()["cover_artwork_id"] is None
    assert reset.json()["artwork_id"] == derived

    # The PATCH restore path works for artists too.
    restored = client.patch(
        f"/api/artists/{artist_id}", json={"cover_artwork_id": cover_id}
    )
    assert restored.status_code == 200
    assert restored.json()["cover_artwork_id"] == cover_id
    assert (
        client.patch(
            f"/api/artists/{artist_id}", json={"cover_artwork_id": 99999}
        ).status_code
        == 422
    )

    assert (
        client.put(
            f"/api/artists/{artist_id}/cover",
            files={"file": ("x.png", b"not-an-image", "image/png")},
        ).status_code
        == 415
    )
    assert (
        client.put(
            "/api/artists/99999/cover", files={"file": ("c.png", png, "image/png")}
        ).status_code
        == 404
    )
    assert client.delete("/api/artists/99999/cover").status_code == 404


def test_rescan_preserves_user_covers(client, library, music, scanner):
    """A rescan rewrites albums' derived art but never the user's choice —
    the cover is curation, like `favorite` and `played_at` (§5)."""
    album_id = client.get("/api/albums").json()["items"][0]["id"]
    artist_id = client.get("/api/artists").json()["items"][0]["id"]
    png = base64.b64decode(PNG_1X1)
    album_cover = client.put(
        f"/api/albums/{album_id}/cover",
        files={"file": ("album.png", png, "image/png")},
    ).json()["cover_artwork_id"]
    artist_cover = client.put(
        f"/api/artists/{artist_id}/cover",
        files={"file": ("artist.png", png, "image/png")},
    ).json()["cover_artwork_id"]

    scanner.run_scan("rescan")

    album = client.get(f"/api/albums/{album_id}").json()
    artist = client.get(f"/api/artists/{artist_id}").json()
    assert album["cover_artwork_id"] == album_cover
    assert artist["cover_artwork_id"] == artist_cover
