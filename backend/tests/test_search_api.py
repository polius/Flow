"""Cross-entity search."""

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


def test_search_punctuation_is_never_a_wildcard(client, library):
    # A query with no word in it is matched literally, wildcards escaped.
    for q in ("%", "_", "%%"):
        assert client.get("/api/search", params={"q": q}).json()["tracks"] == []
    # Inside a word query, punctuation is ignored: "100%" is the word 100.
    out = client.get("/api/search", params={"q": "100%"}).json()
    assert [t["title"] for t in out["tracks"]] == ["100 Percent"]
    # Query syntax is text, not operators.
    for q in ('"', 'a"b', "NOT", "lust OR", "(", "title:", "x*", "^", "a AND b", "{title}"):
        assert client.get("/api/search", params={"q": q}).status_code == 200

    out = client.get("/api/search", params={"q": "100 Perc"}).json()
    assert [t["title"] for t in out["tracks"]] == ["100 Percent"]


@pytest.fixture
def words(client, music):
    """Songs to search by word, added to the library above and scanned: an
    artist with an accent, two-word names, and a title that shares a word
    with another artist."""
    make_mp3(
        music / "mh" / "01 - Blue Hour.mp3",
        title="Blue Hour", artist="Midnight Harbor", album="Blue Hour Sessions",
    )
    make_mp3(
        music / "mh" / "02 - Smoke Rings.mp3",
        title="Smoke Rings", artist="Midnight Harbor", album="Blue Hour Sessions",
    )
    make_mp3(
        music / "af" / "01 - Altitude.mp3",
        title="Altitude", artist="Aurora Fields", album="Sea of Clouds",
    )
    make_mp3(
        music / "b" / "01 - Halo.mp3",
        title="Halo", artist="Beyoncé", album="I Am… Sasha Fierce",
    )
    make_mp3(
        music / "sr" / "01 - Hoppípolla.mp3",
        title="Hoppípolla", artist="Sigur Rós", album="Takk…",
    )
    make_mp3(
        music / "ac" / "01 - Thunderstruck.mp3",
        title="Thunderstruck", artist="AC/DC", album="The Razors Edge",
    )
    make_mp3(
        music / "v" / "01 - Blue Monday.mp3",
        title="Blue Monday", artist="Hour Glass", album="Singles",
    )
    client.app.state.scanner.run_scan("test")
    return music


def _titles(client, q):
    return [t["title"] for t in client.get("/api/search", params={"q": q}).json()["tracks"]]


def test_search_matches_words_in_any_order_across_fields(client, words):
    session = ["Blue Hour", "Smoke Rings"]  # the album "Blue Hour Sessions"
    assert _titles(client, "blue hour") == ["Blue Hour", "Blue Monday", "Smoke Rings"]
    assert _titles(client, "hour blue") == ["Blue Hour", "Blue Monday", "Smoke Rings"]
    # Artist, then title: no single field holds all four words.
    assert _titles(client, "midnight harbor blue hour") == session
    assert _titles(client, "aurora altitude") == ["Altitude"]
    assert _titles(client, "altitude aurora fields") == ["Altitude"]
    # Word beginnings.
    assert _titles(client, "blu ho") == ["Blue Hour", "Blue Monday", "Smoke Rings"]
    assert _titles(client, "mid har smo") == ["Smoke Rings"]
    # Every word must match somewhere.
    assert _titles(client, "blue hour aurora") == []


def test_search_ignores_case_and_accents(client, words):
    assert _titles(client, "beyonce") == ["Halo"]
    assert _titles(client, "BEYONCÉ halo") == ["Halo"]
    assert _titles(client, "sigur ros") == ["Hoppípolla"]
    assert _titles(client, "hoppipolla") == ["Hoppípolla"]
    assert _titles(client, "ac/dc") == ["Thunderstruck"]
    assert _titles(client, "ac dc thunder") == ["Thunderstruck"]

    out = client.get("/api/search", params={"q": "beyonce"}).json()
    assert [a["name"] for a in out["artists"]] == ["Beyoncé"]
    assert [a["title"] for a in out["albums"]] == ["I Am… Sasha Fierce"]
    out = client.get("/api/search", params={"q": "sasha fierce beyonce"}).json()
    assert [a["title"] for a in out["albums"]] == ["I Am… Sasha Fierce"]


def test_search_puts_titles_that_start_with_the_query_first(client, words):
    make_mp3(
        words / "x" / "01 - A Blue Hour Later.mp3",
        title="A Blue Hour Later", artist="Zed", album="Zed",
    )
    client.app.state.scanner.run_scan("test")
    # By title alone "A Blue Hour Later" would lead; the title that begins
    # with the query does.
    assert _titles(client, "blue hour")[:2] == ["Blue Hour", "A Blue Hour Later"]


def test_list_filters_use_the_same_matcher(client, words):
    tracks = client.get("/api/tracks", params={"q": "harbor midnight blu"}).json()
    assert [t["title"] for t in tracks["items"]] == ["Blue Hour", "Smoke Rings"]
    assert tracks["total"] == 2

    albums = client.get("/api/albums", params={"q": "sessions midnight"}).json()
    assert [a["title"] for a in albums["items"]] == ["Blue Hour Sessions"]
    assert albums["total"] == 1

    artists = client.get("/api/artists", params={"q": "ros sig"}).json()
    assert [a["name"] for a in artists["items"]] == ["Sigur Rós"]
    assert artists["total"] == 1


def test_search_index_follows_edits_and_removals(client, words):
    track = client.get("/api/tracks", params={"q": "altitude"}).json()["items"][0]

    client.patch(f"/api/tracks/{track['id']}", json={"title": "Cruising Height"})
    assert _titles(client, "altitude") == []
    assert _titles(client, "aurora cruising") == ["Cruising Height"]

    client.patch(f"/api/tracks/{track['id']}", json={"artist": "Élan Vital", "album": "Lift"})
    assert _titles(client, "sea clouds") == []  # it left that album
    assert _titles(client, "elan lift cruising") == ["Cruising Height"]

    # Undo puts the old names back, in the index too.
    assert client.post("/api/tracks/bulk/undo").status_code == 200
    assert _titles(client, "elan") == []
    assert _titles(client, "sea clouds cruising") == ["Cruising Height"]

    (words / "af" / "01 - Altitude.mp3").unlink()
    client.app.state.scanner.run_scan("test")
    assert _titles(client, "cruising") == []
    conn = client.app.state.db.connect()
    assert conn.execute("SELECT COUNT(*) FROM track_search").fetchone()[0] == conn.execute(
        "SELECT COUNT(*) FROM tracks"
    ).fetchone()[0]


def test_search_tracks_carry_every_track_field(client, library):
    """Search used to build TrackOut by hand and leave fields at their
    defaults; it must answer exactly what the track endpoint does."""
    track = client.get("/api/tracks", params={"q": "lust"}).json()["items"][0]
    client.patch(f"/api/tracks/{track['id']}", json={"genre": "Rock"})
    client.patch("/api/queue", json={"played_track_id": track["id"]})

    full = client.get(f"/api/tracks/{track['id']}").json()
    found = client.get("/api/search", params={"q": "lust"}).json()["tracks"][0]
    assert found == full
    assert found["genre"] == "Rock" and found["played_at"] and found["added_at"]
