"""Cross-entity search — DESIGN.md §6."""

from __future__ import annotations

import pytest
from tests.audio_fixtures import make_mp3


@pytest.fixture
def library(music):
    make_mp3(
        music / "a" / "01 - Young Lust.mp3",
        title="Young Lust", artist="Aerosmith", album="Pump",
    )
    make_mp3(
        music / "m" / "01 - New Born.mp3",
        title="New Born", artist="Muse", album="Origin",
    )
    make_mp3(music / "weird.mp3", title="100 Percent")
    return music


def test_search_hits_every_entity_type(client, library):
    client.post("/api/playlists", json={"name": "Muse Mix"})
    pid = client.post("/api/playlists", json={"name": "Lust List"}).json()["id"]
    track = client.get("/api/tracks", params={"q": "lust"}).json()["items"][0]
    client.post(f"/api/playlists/{pid}/tracks", json={"track_ids": [track["id"]]})

    out = client.get("/api/search", params={"q": "lust"}).json()
    assert [t["title"] for t in out["tracks"]] == ["Young Lust"]
    assert [p["name"] for p in out["playlists"]] == ["Lust List"]

    out = client.get("/api/search", params={"q": "muse"}).json()
    assert [t["title"] for t in out["tracks"]] == ["New Born"]
    assert [a["name"] for a in out["artists"]] == ["Muse"]
    assert [p["name"] for p in out["playlists"]] == ["Muse Mix"]

    out = client.get("/api/search", params={"q": "pump"}).json()
    assert [a["title"] for a in out["albums"]] == ["Pump"]
    assert [t["title"] for t in out["tracks"]] == ["Young Lust"]  # album match


def test_search_requires_q_and_handles_no_results(client, library):
    assert client.get("/api/search").status_code == 422

    out = client.get("/api/search", params={"q": "zzzznope"}).json()
    assert out == {
        "query": "zzzznope", "tracks": [], "albums": [], "artists": [], "playlists": [],
    }


def test_search_escapes_like_wildcards(client, library):
    out = client.get("/api/search", params={"q": "100%"}).json()
    assert out["tracks"] == []  # % is a literal, not a wildcard

    out = client.get("/api/search", params={"q": "100 Perc"}).json()
    assert [t["title"] for t in out["tracks"]] == ["100 Percent"]
