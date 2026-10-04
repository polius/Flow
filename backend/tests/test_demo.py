"""Demo mode: catalog generation, database dressing, lifespan-guard behavior."""

from mutagen.id3 import ID3

from app import demo
from app.tags import parse_audio


def test_generate_library_writes_tagged_files(music):
    expected = demo.generate_library(music, albums_limit=3)

    files = sorted(music.rglob("*.mp3"))
    assert len(files) == expected == 29  # Velvet Hour's first three albums

    # Anchored titles come first, so the first file is deterministic.
    parsed = parse_audio(files[0])
    assert parsed.title == "Sunday Skin"
    assert parsed.artist == "Velvet Hour"
    assert parsed.album == "Hazy Days"
    assert parsed.track_no == 1
    assert parsed.year == 2018
    assert parsed.genres == ["Dream Pop"]
    assert parsed.duration > 60  # realistic lengths, not 1-second blips

    art = ID3(str(files[0])).getall("APIC")
    assert art and art[0].data.startswith(b"\x89PNG")  # embedded cover


def test_generate_library_is_deterministic(music, tmp_path):
    a = demo.generate_library(music, albums_limit=2)
    b = demo.generate_library(tmp_path / "again", albums_limit=2)
    assert a == b
    rel = sorted(p.relative_to(music).as_posix() for p in music.rglob("*.mp3"))
    rel2 = sorted(
        p.relative_to(tmp_path / "again").as_posix() for p in (tmp_path / "again").rglob("*.mp3")
    )
    assert rel == rel2


def test_seed_database_dresses_demo(db, music, scanner):
    demo.generate_library(music, albums_limit=3)
    scanner.run_scan("test")

    assert demo.seed_database(db) is True

    conn = db.connect()
    favorites = conn.execute("SELECT COUNT(*) AS c FROM tracks WHERE favorite = 1").fetchone()["c"]
    assert 10 <= favorites < 29  # two whole albums + a few singles

    playlists = conn.execute("SELECT name FROM playlists ORDER BY id").fetchall()
    assert [r["name"] for r in playlists] == [spec[0] for spec in demo.PLAYLIST_SPECS]

    counts = conn.execute(
        "SELECT p.name, COUNT(pt.track_id) AS c FROM playlists p "
        "LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id GROUP BY p.id ORDER BY p.id"
    ).fetchall()
    spec_sizes = {spec[0]: spec[3] for spec in demo.PLAYLIST_SPECS}
    for row in counts:
        # Genre pools shrink in a 3-album subset, so ≤ the spec size.
        assert row["c"] <= spec_sizes[row["name"]]


def test_seed_database_is_one_shot(db, music, scanner):
    demo.generate_library(music, albums_limit=3)
    scanner.run_scan("test")

    assert demo.seed_database(db) is True
    assert demo.seed_database(db) is False  # already dressed

    conn = db.connect()
    assert conn.execute("SELECT COUNT(*) AS c FROM playlists").fetchone()["c"] == len(
        demo.PLAYLIST_SPECS
    )


def test_prepare_library_fills_empty(db, music, monkeypatch):
    monkeypatch.setattr(demo.config, "MUSIC_DIR", music)
    expected = demo.prepare_library(db)

    assert expected is not None and expected > 0
    assert len(list(music.rglob("*.mp3"))) == expected


def test_prepare_library_never_touches_files(db, music, monkeypatch):
    stray = music / "real song.mp3"
    stray.write_bytes(b"\x00")
    monkeypatch.setattr(demo.config, "MUSIC_DIR", music)

    assert demo.prepare_library(db) is None
    assert list(music.iterdir()) == [stray]  # nothing generated, stray untouched
