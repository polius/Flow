"""Startup bootstrap: the first run must be turn-key — a missing music
folder is created, and an existing one is never touched."""

from __future__ import annotations


def test_bootstrap_creates_missing_music_dir(tmp_path, monkeypatch):
    from app import config, main
    from app.db import Database

    music = tmp_path / "music"
    assert not music.exists()

    db = Database(tmp_path / "flow.db")
    db.init()
    monkeypatch.setattr(config, "MUSIC_DIR", music)
    main._bootstrap(db)

    assert music.is_dir()


def test_bootstrap_never_touches_an_existing_music_dir(tmp_path, monkeypatch):
    from app import config, main
    from app.db import Database

    music = tmp_path / "music"
    music.mkdir()
    (music / "song.mp3").write_bytes(b"keep")

    db = Database(tmp_path / "flow.db")
    db.init()
    monkeypatch.setattr(config, "MUSIC_DIR", music)
    main._bootstrap(db)

    assert (music / "song.mp3").read_bytes() == b"keep"
    assert list(music.iterdir()) == [music / "song.mp3"]


def test_bootstrap_creates_nested_music_dir(tmp_path, monkeypatch):
    from app import config, main
    from app.db import Database

    music = tmp_path / "deep" / "nested" / "music"

    db = Database(tmp_path / "flow.db")
    db.init()
    monkeypatch.setattr(config, "MUSIC_DIR", music)
    main._bootstrap(db)

    assert music.is_dir()
