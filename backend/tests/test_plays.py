"""A listening history (G2): a counted play adds one row; anything else
adds none; songs and albums sort by plays; the settings count them."""

from __future__ import annotations

import pytest

from tests.audio_fixtures import make_mp3


@pytest.fixture
def library(music):
    for i, (album, title) in enumerate(
        [("Album A", "One"), ("Album A", "Two"), ("Album B", "Three"), ("Album B", "Four")]
    ):
        make_mp3(music / album / f"{i}.mp3", title=title, artist="Artist", album=album)
    return music


def _ids(client):
    return {t["title"]: t["id"] for t in client.get("/api/tracks").json()["items"]}


def _played(client, track_id):
    return client.patch("/api/queue", json={"played_track_id": track_id})


def test_a_counted_play_adds_one_row_and_nothing_else_does(client, library):
    ids = _ids(client)
    conn = client.app.state.db.connect()
    count = lambda: conn.execute("SELECT COUNT(*) c FROM plays").fetchone()["c"]  # noqa: E731
    client.patch("/api/queue", json={"position": 12.0})  # a playhead save, a skip: no play
    assert count() == 0
    assert _played(client, ids["Two"]).status_code == 200
    assert count() == 1
    row = conn.execute("SELECT track_id, played_at FROM plays").fetchone()
    assert row["track_id"] == ids["Two"] and row["played_at"]
    assert _played(client, 999_999).status_code == 200  # an unknown song is no play
    assert count() == 1
    assert client.get("/api/settings").json()["counts"]["plays"] == 1


def test_songs_and_albums_sort_by_plays(client, library):
    ids = _ids(client)
    for title, n in (("Three", 3), ("One", 1), ("Four", 2)):
        for _ in range(n):
            _played(client, ids[title])
    songs = client.get("/api/tracks", params={"sort": "plays", "dir": "desc"}).json()["items"]
    assert [t["title"] for t in songs] == ["Three", "Four", "One", "Two"]
    albums = client.get("/api/albums", params={"sort": "plays", "dir": "desc"}).json()["items"]
    assert [a["title"] for a in albums] == ["Album B", "Album A"]


def test_a_removed_song_takes_its_history_with_it(client, library):
    ids = _ids(client)
    _played(client, ids["One"])
    (library / "Album A" / "0.mp3").unlink()
    client.app.state.scanner.run_scan("test")
    conn = client.app.state.db.connect()
    assert conn.execute("SELECT COUNT(*) c FROM plays").fetchone()["c"] == 0
