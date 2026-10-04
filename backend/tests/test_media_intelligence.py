"""Media intelligence: credited artists + genres, Sound Check gain, and the
scan error disclosure + mount-guard state."""

from __future__ import annotations

import os

import pytest
from tests.audio_fixtures import make_flac, make_mp3

from app.loudness import clamp_gain, parse_integrated_lufs
from app.tags import _gain_db, _normalize_genres, _split_featured


def track_row(conn, rel: str):
    return conn.execute("SELECT * FROM tracks WHERE path = ?", (rel,)).fetchone()


@pytest.fixture
def library(music):
    """conftest's `client` fixture depends on a module-level `library`; the
    default here is the empty music dir (custom tests repoint the scanner)."""
    return music


def credited_track_counts(conn) -> dict[str, int]:
    """The same DISTINCT-credited count the /api/artists endpoint uses."""
    return {
        row["name"]: row["c"]
        for row in conn.execute(
            "SELECT ar.name AS name, (SELECT COUNT(*) FROM ("
            "  SELECT t.id FROM tracks t WHERE t.artist_id = ar.id"
            "  UNION"
            "  SELECT ta.track_id FROM track_artists ta WHERE ta.artist_id = ar.id"
            ")) AS c FROM artists ar"
        )
    }


# ---- tag parsing: credits + genres ----


def test_split_featured():
    assert _split_featured("A feat. B") == ("A", ["B"])
    assert _split_featured("A ft. B") == ("A", ["B"])
    assert _split_featured("A featuring B") == ("A", ["B"])
    # "&" stays one artist — "Simon & Garfunkel" is a single credit.
    assert _split_featured("Simon & Garfunkel") == ("Simon & Garfunkel", [])
    assert _split_featured("Solo") == ("Solo", [])
    assert _split_featured("  ") == (None, [])


def test_normalize_genres():
    assert _normalize_genres(["Electronic"]) == ["Electronic"]
    assert _normalize_genres(["Pop; Rock"]) == ["Pop", "Rock"]
    assert _normalize_genres(["Hip-Hop/Rap"]) == ["Hip-Hop", "Rap"]
    # ID3v2.3 numeric refs strip to the name; case-insensitive dedupe.
    assert _normalize_genres(["(17)Rock", "rock"]) == ["Rock"]


def test_gain_db_parsing():
    assert _gain_db("-7.2 dB") == -7.2
    assert _gain_db("+3.1dB") == 3.1
    assert _gain_db("−5") == -5.0  # U+2212 minus, seen in the wild
    assert _gain_db("loud") is None
    assert _gain_db(None) is None


# ---- scan: credits, genres, gain fast path ----


@pytest.fixture
def credit_library(music):
    make_mp3(
        music / "lead.mp3",
        title="Lead", artist="Astra", album="Peak", albumartist="Astra",
    )
    make_mp3(
        music / "feat.mp3",
        title="With", artist="Astra feat. Nova", album="Peak", albumartist="Astra",
    )
    # Repeated TPE1 values (ID3v2.4 multi-value) = two main credits.
    from mutagen.id3 import ID3, TPE1

    path = make_mp3(music / "duo.mp3", title="Duo", album="Peak", albumartist="Astra")
    tags = ID3(str(path))
    tags.add(TPE1(encoding=3, text=["Astra", "Nova"]))
    tags.save(str(path))
    flac = make_flac(music / "genre.flac", title="Genre", artist="Astra", album="Soundtracks")
    from mutagen.flac import FLAC

    f = FLAC(str(flac))
    f["genre"] = ["Electronic; Ambient"]
    f["replaygain_track_gain"] = ["-6.5 dB"]
    f.save()
    return music


def test_featured_artist_is_browsable(conn, music, scanner, credit_library):
    scanner.run_scan("test")
    counts = credited_track_counts(conn)
    assert counts == {"Astra": 4, "Nova": 2}


def test_credits_table_shapes(conn, music, scanner, credit_library):
    scanner.run_scan("test")
    feat = track_row(conn, "feat.mp3")
    roles = {
        r["name"]: r["role"]
        for r in conn.execute(
            "SELECT ar.name, ta.role FROM track_artists ta "
            "JOIN artists ar ON ar.id = ta.artist_id WHERE ta.track_id = ?",
            (feat["id"],),
        )
    }
    assert roles == {"Astra": "main", "Nova": "featured"}

    duo = track_row(conn, "duo.mp3")
    mains = [
        r["name"]
        for r in conn.execute(
            "SELECT ar.name FROM track_artists ta "
            "JOIN artists ar ON ar.id = ta.artist_id "
            "WHERE ta.track_id = ? AND ta.role = 'main' ORDER BY ta.position",
            (duo["id"],),
        )
    ]
    assert mains == ["Astra", "Nova"]


def test_genres_parsed_and_browsable(conn, music, scanner, credit_library):
    scanner.run_scan("test")
    genre = conn.execute(
        "SELECT id, name FROM genres WHERE name = 'Electronic'"
    ).fetchone()
    assert genre is not None
    amb = conn.execute("SELECT id FROM genres WHERE name = 'Ambient'").fetchone()
    assert amb is not None
    row = track_row(conn, "genre.flac")
    members = [
        r["genre_id"]
        for r in conn.execute(
            "SELECT genre_id FROM track_genres WHERE track_id = ?", (row["id"],)
        )
    ]
    assert genre["id"] in members and amb["id"] in members


def test_replaygain_tag_is_the_fast_path(conn, music, scanner, credit_library):
    scanner.run_scan("test")
    row = track_row(conn, "genre.flac")
    assert row["gain_db"] == pytest.approx(-6.5)
    # Untagged files stay NULL until the analysis phase measures them.
    assert track_row(conn, "lead.mp3")["gain_db"] is None


# ---- scan: error log + mount guard ----


def test_error_log_lists_path_and_reason(conn, music, scanner):
    (music / "junk.mp3").write_bytes(b"garbage")
    make_mp3(music / "good.mp3", title="Good", artist="G")
    scanner.run_scan("test")
    log = scanner.scan_error_log()
    assert log["total"] == 1
    assert log["items"][0]["path"] == "junk.mp3"
    assert "Unreadable" in log["items"][0]["reason"]


def test_mount_guard_flag_persists_and_clears(conn, music, scanner):
    make_mp3(music / "keep.mp3", title="Keep", artist="K")
    scanner.run_scan("test")
    row = conn.execute(
        "SELECT value FROM settings WHERE key = 'scan_mount_guard'"
    ).fetchone()
    assert row is not None and row["value"] == "0"

    # The broken-mount trip: empty walk against a populated index.
    for f in music.iterdir():
        f.unlink()
    scanner.run_scan("test")
    state = scanner.current_state_event()
    assert state["mount_guard"] is True
    log = scanner.scan_error_log()
    assert log["total"] == 1
    assert "unreachable" in log["items"][0]["reason"]

    # A walk that finds files again clears the flag.
    make_mp3(music / "back.mp3", title="Back", artist="B")
    scanner.run_scan("test")
    assert scanner.current_state_event()["mount_guard"] is False


# ---- API: genres endpoint + genre filter + credited artist detail ----


@pytest.fixture
def api_client(client, library, conn, credit_library, monkeypatch):
    """The `client` fixture scans `library` at setup; this variant instead
    scans the credit library so the API sees credited artists and genres."""
    from app import config as app_config

    monkeypatch.setattr(app_config, "MUSIC_DIR", credit_library)
    client.app.state.scanner._music = credit_library
    client.app.state.scanner.run_scan("api")
    return client


def test_genres_endpoint(api_client):
    resp = api_client.get("/api/genres")
    assert resp.status_code == 200
    body = resp.json()
    names = {g["name"]: g for g in body["items"]}
    assert names["Electronic"]["track_count"] == 1
    assert names["Electronic"]["album_count"] == 1
    assert names["Electronic"]["artwork_id"] is None or isinstance(
        names["Electronic"]["artwork_id"], int
    )


def test_genre_filter_on_tracks(api_client):
    genre = next(
        g for g in api_client.get("/api/genres").json()["items"] if g["name"] == "Ambient"
    )
    body = api_client.get("/api/tracks", params={"genre_id": genre["id"]}).json()
    assert body["total"] == 1
    assert body["items"][0]["path"] == "genre.flac"


def test_featured_artist_detail_includes_credits(api_client):
    artists = api_client.get("/api/artists").json()["items"]
    nova = next(a for a in artists if a["name"] == "Nova")
    assert nova["track_count"] == 2
    detail = api_client.get(f"/api/artists/{nova['id']}").json()
    titles = {t["title"] for t in detail["tracks"]}
    assert titles == {"With", "Duo"}


def test_track_out_carries_gain(api_client):
    items = api_client.get("/api/tracks").json()["items"]
    by_path = {t["path"]: t for t in items}
    assert by_path["genre.flac"]["gain_db"] == pytest.approx(-6.5)
    assert by_path["lead.mp3"]["gain_db"] is None


# ---- API: album/artist sort directions ----


@pytest.fixture
def sort_library(music):
    make_mp3(music / "a1.mp3", title="One", artist="Zeta", album="Aurora", year="2001")
    make_mp3(music / "a2.mp3", title="Two", artist="Zeta", album="Aurora", year="2001")
    make_mp3(music / "b1.mp3", title="Three", artist="Alpha", album="Borealis", year="1999")
    return music


def test_album_sort_direction(client, library, sort_library, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config, "MUSIC_DIR", sort_library)
    client.app.state.scanner._music = sort_library
    client.app.state.scanner.run_scan("sort")

    titles = lambda d: [a["title"] for a in d["items"]]  # noqa: E731
    asc = client.get("/api/albums", params={"sort": "year", "dir": "asc"}).json()
    assert titles(asc) == ["Borealis", "Aurora"]
    desc = client.get("/api/albums", params={"sort": "year", "dir": "desc"}).json()
    assert titles(desc) == ["Aurora", "Borealis"]


def test_artist_sort_by_songs_desc(client, library, sort_library, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config, "MUSIC_DIR", sort_library)
    client.app.state.scanner._music = sort_library
    client.app.state.scanner.run_scan("sort")

    names = [
        a["name"]
        for a in client.get("/api/artists", params={"sort": "songs", "dir": "desc"}).json()[
            "items"
        ]
    ]
    assert names == ["Zeta", "Alpha"]


# ---- compilation resolution: bulk album_artist ----


@pytest.fixture
def compilation(music):
    make_mp3(
        music / "c1.mp3", title="C1", artist="Various", album="Mixtape",
        albumartist="DJ One",
    )
    make_mp3(
        music / "c2.mp3", title="C2", artist="Someone Else", album="Mixtape",
        albumartist="DJ Two",
    )
    return music


def test_bulk_album_artist_unifies_album(client, library, compilation, monkeypatch):
    """Inconsistent album-artist tags yield one album row per value; the
    bulk apply pins one album artist on every selected track AND its album
    row — the Organize gesture that resolves a compilation."""
    from app import config as app_config

    monkeypatch.setattr(app_config, "MUSIC_DIR", compilation)
    client.app.state.scanner._music = compilation
    client.app.state.scanner.run_scan("comp")

    tracks = client.get("/api/tracks").json()["items"]
    ids = sorted(t["id"] for t in tracks)
    resp = client.post(
        "/api/tracks/bulk", json={"track_ids": ids, "album_artist": "Mixtape Masters"}
    )
    assert resp.status_code == 200
    assert resp.json()["applied"] == 2

    albums = client.get("/api/albums").json()["items"]
    assert {a["artist"] for a in albums} == {"Mixtape Masters"}

    # Undo restores each track's former album artist by name.
    undo = client.post("/api/tracks/bulk/undo")
    assert undo.status_code == 200
    artists = sorted(a["artist"] for a in client.get("/api/albums").json()["items"])
    assert artists == ["DJ One", "DJ Two"]


def test_bulk_album_artist_clear(client, library, compilation, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config, "MUSIC_DIR", compilation)
    client.app.state.scanner._music = compilation
    client.app.state.scanner.run_scan("comp")

    tracks = client.get("/api/tracks").json()["items"]
    ids = sorted(t["id"] for t in tracks)
    resp = client.post("/api/tracks/bulk", json={"track_ids": ids, "album_artist": ""})
    assert resp.status_code == 200
    albums = client.get("/api/albums").json()["items"]
    assert {a["artist"] for a in albums} == {None}


# ---- loudness analysis parsing ----


FFMPEG_SUMMARY = """
[Parsed_ebur128_0 @ 0x7f8] Summary:

  Integrated loudness:
    I:        -12.3 LUFS
    Threshold: -22.4 LUFS

  Loudness range:
    LRA:       7.1 LU
"""


def test_parse_integrated_lufs():
    assert parse_integrated_lufs(FFMPEG_SUMMARY) == pytest.approx(-12.3)
    assert parse_integrated_lufs("no summary here") is None


def test_clamp_gain():
    assert clamp_gain(3.25) == 3.2
    assert clamp_gain(-40.0) == -24.0
    assert clamp_gain(12.0) == 6.0


def test_analysis_marks_measured_tracks(conn, music, scanner, monkeypatch):
    """With a stubbed analyzer, the phase fills gain_db for NULL rows only."""
    from app import loudness

    make_mp3(music / "x.mp3", title="X", artist="X")
    make_flac(music / "y.flac", title="Y", artist="X")
    scanner.run_scan("test")
    assert scanner.scan_error_log()["total"] == 0

    calls: list[str] = []

    def fake_analyze(path):
        calls.append(os.path.basename(str(path)))
        return -3.0

    # Patch both namespaces: scanner imported ffmpeg_available directly
    # (`from app.loudness import ...`), so a loudness-only patch leaves the
    # real guard active — and CI, without ffmpeg, skips the whole phase.
    monkeypatch.setattr(loudness, "ffmpeg_available", lambda: True)
    monkeypatch.setattr("app.scanner.ffmpeg_available", lambda: True)
    monkeypatch.setattr("app.scanner.analyze_file", fake_analyze)
    scanner._analyze_gains()
    gains = {
        r["path"]: r["gain_db"]
        for r in conn.execute("SELECT path, gain_db FROM tracks")
    }
    assert gains == {"x.mp3": -3.0, "y.flac": -3.0}
    assert sorted(calls) == ["x.mp3", "y.flac"]
    # The phase must end idle — the UI hangs on "Analyzing…" otherwise.
    state = scanner.current_state_event()
    assert state["state"] == "idle"
    assert state["phase"] is None
