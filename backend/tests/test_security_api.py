"""Artwork can never act as a document (stored XSS), cross-site pages can't
trigger writes, and request payloads are bounded."""

from __future__ import annotations

import sqlite3

import pytest
from mutagen.id3 import APIC, ID3

from tests.audio_fixtures import jpeg_bytes, make_mp3

SVG_XSS = (
    b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'
    b"<script>fetch('/api/auth/password',{method:'PUT'})</script></svg>"
)


def _add_apic(path, data: bytes, mime: str, picture_type: int = 3) -> None:
    tags = ID3(str(path))
    tags.add(APIC(encoding=3, mime=mime, type=picture_type, desc="x", data=data))
    tags.save(str(path), v2_version=3)


@pytest.fixture
def library(music):
    # The audit's repro: an APIC frame that claims image/svg+xml and
    # carries a script.
    evil = make_mp3(music / "Evil" / "evil.mp3", title="Evil", artist="X", album="Evil")
    _add_apic(evil, SVG_XSS, "image/svg+xml")
    # Same, but the folder has a real cover: that one must win.
    hidden = make_mp3(
        music / "Hidden" / "hidden.mp3", title="Hidden", artist="X", album="Hidden"
    )
    _add_apic(hidden, SVG_XSS, "image/svg+xml")
    (music / "Hidden" / "cover.jpg").write_bytes(jpeg_bytes())
    # A non-front SVG next to a real front JPEG: the JPEG is used.
    mixed = make_mp3(
        music / "Mixed" / "mixed.mp3", title="Mixed", artist="X", album="Mixed",
        picture=jpeg_bytes(),
    )
    _add_apic(mixed, SVG_XSS, "image/svg+xml", picture_type=0)
    return music


def _track(client, title):
    items = client.get("/api/tracks", params={"q": title}).json()["items"]
    return next(t for t in items if t["title"] == title)


def test_svg_apic_is_never_stored(client, library, db_path):
    assert _track(client, "Evil")["artwork_id"] is None

    hidden = _track(client, "Hidden")["artwork_id"]
    assert hidden is not None
    response = client.get(f"/api/artwork/{hidden}")
    assert response.headers["content-type"] == "image/jpeg"

    mixed = _track(client, "Mixed")["artwork_id"]
    assert client.get(f"/api/artwork/{mixed}").content == jpeg_bytes()

    conn = sqlite3.connect(db_path)
    mimes = {row[0] for row in conn.execute("SELECT mime FROM artwork")}
    blobs = [row[0] for row in conn.execute("SELECT blob FROM artwork")]
    conn.close()
    assert mimes <= {"image/jpeg", "image/png"}
    assert all(b"<script" not in bytes(b) for b in blobs)


@pytest.fixture
def db_path(client):
    from app import config

    return config.DB_PATH


def test_rows_stored_by_older_versions_are_served_inert(client, db_path):
    """A v1.5.0 row with the tag-claimed SVG type, before any rescan: the
    bytes decide the type, and the headers neuter it either way."""
    conn = sqlite3.connect(db_path)
    cur = conn.execute(
        "INSERT INTO artwork (hash, blob, mime) VALUES ('legacy-svg', ?, 'image/svg+xml')",
        (SVG_XSS,),
    )
    conn.commit()
    conn.close()

    response = client.get(f"/api/artwork/{cur.lastrowid}")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    # A resize request never feeds active content to ffmpeg either.
    sized = client.get(f"/api/artwork/{cur.lastrowid}", params={"s": 64})
    assert sized.headers["content-type"] == "application/octet-stream"


def test_artwork_cache_is_private(client, library):
    artwork_id = _track(client, "Hidden")["artwork_id"]
    response = client.get(f"/api/artwork/{artwork_id}")
    assert response.headers["cache-control"] == "private, max-age=31536000, immutable"


# ---- cross-site writes ----------------------------------------------------------


def test_cross_site_writes_are_refused(client, library):
    # The audit's repro: POST /api/scan from another site.
    refused = client.post("/api/scan", headers={"Origin": "http://evil.example"})
    assert refused.status_code == 403
    assert client.post(
        "/api/tracks/bulk/undo", headers={"Sec-Fetch-Site": "cross-site"}
    ).status_code == 403
    # Sandboxed frames and file:// pages send "null".
    assert client.post("/api/scan", headers={"Origin": "null"}).status_code == 403
    # Same host, different explicit port: a different origin.
    assert client.post(
        "/api/scan",
        headers={"Origin": "http://flow.lan:9999", "Host": "flow.lan:8080"},
    ).status_code == 403


def test_same_origin_and_non_browser_writes_pass(client, library):
    # No browser provenance (curl, scripts): allowed. The patched scanner
    # answers "already running" — the request got through the guard.
    assert client.post("/api/scan").status_code == 409
    assert client.post(
        "/api/scan", headers={"Origin": "http://testserver"}
    ).status_code == 409
    assert client.post(
        "/api/scan", headers={"Sec-Fetch-Site": "same-origin", "Origin": "http://testserver"}
    ).status_code == 409
    # nginx forwards `Host: $host` (no port) while the browser's Origin
    # carries the published port.
    assert client.post(
        "/api/scan", headers={"Origin": "http://nas.local:8080", "Host": "nas.local"}
    ).status_code == 409
    # Reads are never blocked.
    assert client.get(
        "/api/settings", headers={"Origin": "http://evil.example"}
    ).status_code == 200


def test_reverse_proxy_public_name_is_accepted(client, library):
    """Behind Traefik/Caddy the public name may survive only in
    X-Forwarded-Host while Host is the internal one."""
    headers = {
        "Origin": "https://music.example.com",
        "Host": "flow:8080",
        "X-Forwarded-Host": "music.example.com",
    }
    assert client.post("/api/scan", headers=headers).status_code == 409
    headers["Origin"] = "https://evil.example"
    assert client.post("/api/scan", headers=headers).status_code == 403
    # A proxy that rewrites Host and sets no X-Forwarded-Host: a modern
    # browser's Sec-Fetch-Site still lets the app's own writes through…
    assert client.post(
        "/api/scan",
        headers={
            "Origin": "https://music.example.com",
            "Host": "flow:8080",
            "Sec-Fetch-Site": "same-origin",
        },
    ).status_code == 409
    # …while a sibling subdomain ("same-site") is still checked.
    assert client.post(
        "/api/scan",
        headers={
            "Origin": "https://blog.example.com",
            "Host": "music.example.com",
            "Sec-Fetch-Site": "same-site",
        },
    ).status_code == 403


# ---- payload caps ---------------------------------------------------------------


def test_oversized_inputs_are_rejected(client, library):
    assert client.get("/api/tracks", params={"q": "x" * 501}).status_code == 422
    assert client.get("/api/search", params={"q": "x" * 501}).status_code == 422
    assert client.post("/api/playlists", json={"name": "x" * 1001}).status_code == 422
    track = _track(client, "Evil")
    assert client.patch(
        f"/api/tracks/{track['id']}", json={"title": "x" * 1001}
    ).status_code == 422
    assert client.post(
        "/api/favorites/bulk", json={"track_ids": [1] * 50_001, "favorite": True}
    ).status_code == 422
