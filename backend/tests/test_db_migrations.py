"""The migration runner: atomic per-file transactions, a pre-migration
backup, the newer-schema guard, and a v1.5.0 database upgrading with every
piece of user data intact."""

from __future__ import annotations

import json
import sqlite3

import pytest

from app import db as db_module
from app.db import Database, SchemaTooNewError

MIGRATIONS = db_module.MIGRATIONS_DIR
LATEST = max(int(p.name.split("_", 1)[0]) for p in MIGRATIONS.glob("[0-9]*.sql"))


def _v150_database(path):
    """A database exactly as v1.5.0 left it: 001 applied, user_version 1,
    with user data in every table an upgrade must keep."""
    conn = sqlite3.connect(path)
    conn.executescript((MIGRATIONS / "001_init.sql").read_text(encoding="utf-8"))
    conn.execute("PRAGMA user_version = 1")
    conn.executescript(
        """
        INSERT INTO artists (id, name) VALUES (1, 'Artist');
        INSERT INTO albums (id, title, artist_id) VALUES (1, 'Album', 1);
        INSERT INTO artwork (id, hash, blob, mime) VALUES
          (1, 'a', X'FFD8FF00', 'image/jpeg'),
          (2, 'b', CAST('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' AS BLOB), 'image/svg+xml');
        INSERT INTO tracks (id, path, title, artist_id, album_id, duration, format,
                            mtime, user_edited, favorite, favorite_position, played_at,
                            artwork_id, added_at)
          VALUES (1, 'a.mp3', 'Edited title', 1, 1, 10, 'mp3', 1, 1, 1, 1,
                  '2026-01-01T00:00:00+00:00', 1, '2026-01-01T00:00:00+00:00');
        INSERT INTO playlists (id, name, created_at) VALUES (1, 'Mix', '2026-01-01');
        INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 1, 1);
        INSERT INTO queue_items (position, track_id) VALUES (0, 1);
        UPDATE queue_state SET play_order = '[0]', order_pos = 0 WHERE id = 0;
        INSERT INTO settings (key, value) VALUES ('auth_password', 'pbkdf2_sha256$1$x$y');
        """
    )
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('auth_sessions', ?)",
        (json.dumps({"plain-token": 4102444800.0}),),
    )
    conn.commit()
    conn.close()


def test_fresh_database_gets_every_migration(tmp_path):
    database = Database(tmp_path / "flow.db")
    database.init()
    conn = database.connect()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == LATEST
    assert conn.execute("SELECT COUNT(*) FROM queue_state").fetchone()[0] == 1
    # Nothing to back up on a brand-new database.
    assert not (tmp_path / "backups").exists()
    database.close_all()


def test_v150_database_upgrades_with_all_user_data_and_a_backup(tmp_path):
    path = tmp_path / "flow.db"
    _v150_database(path)

    database = Database(path)
    database.init()
    conn = database.connect()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == LATEST
    track = conn.execute("SELECT * FROM tracks WHERE id = 1").fetchone()
    assert track["title"] == "Edited title"
    assert track["user_edited"] == 1 and track["favorite"] == 1
    assert track["played_at"] == "2026-01-01T00:00:00+00:00"
    assert conn.execute("SELECT COUNT(*) FROM playlist_tracks").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM queue_items").fetchone()[0] == 1
    assert conn.execute(
        "SELECT value FROM settings WHERE key = 'auth_password'"
    ).fetchone()[0] == "pbkdf2_sha256$1$x$y"
    # 002: a tag-claimed active type is neutralized; real images untouched.
    mimes = dict(conn.execute("SELECT id, mime FROM artwork").fetchall())
    assert mimes == {1: "image/jpeg", 2: "application/octet-stream"}

    backups = list((tmp_path / "backups").glob("flow-v1-*.db"))
    assert len(backups) == 1
    snapshot = sqlite3.connect(backups[0])
    assert snapshot.execute("PRAGMA user_version").fetchone()[0] == 1
    assert snapshot.execute("SELECT title FROM tracks").fetchone()[0] == "Edited title"
    snapshot.close()
    database.close_all()


def test_up_to_date_database_is_left_alone(tmp_path):
    database = Database(tmp_path / "flow.db")
    database.init()
    database.init()  # second boot: nothing pending, no backup
    assert not (tmp_path / "backups").exists()
    database.close_all()


def test_newer_schema_is_refused_with_a_clear_error(tmp_path):
    path = tmp_path / "flow.db"
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {LATEST + 1}")
    conn.close()

    database = Database(path)
    with pytest.raises(SchemaTooNewError, match="newer Flow"):
        database.init()
    database.close_all()


def test_failed_migration_rolls_back_whole_file(tmp_path, monkeypatch):
    """A file that fails halfway leaves no partial tables and no version
    bump — the next boot retries it cleanly instead of crash-looping on
    "table already exists"."""
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "001_init.sql").write_text(
        (MIGRATIONS / "001_init.sql").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (migrations / "002_broken.sql").write_text(
        "CREATE TABLE half_done (id INTEGER);\nINSERT INTO no_such_table VALUES (1);\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(db_module, "MIGRATIONS_DIR", migrations)

    database = Database(tmp_path / "flow.db")
    with pytest.raises(sqlite3.OperationalError):
        database.init()
    conn = database.connect()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = 'half_done'"
    ).fetchone()[0] == 0
    assert not conn.in_transaction

    # Fixed file: the next boot applies it.
    (migrations / "002_broken.sql").write_text(
        "CREATE TABLE half_done (id INTEGER);\n", encoding="utf-8"
    )
    database.init()
    assert database.connect().execute("PRAGMA user_version").fetchone()[0] == 2
    database.close_all()


def test_only_the_newest_backups_are_kept(tmp_path, monkeypatch):
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "001_init.sql").write_text("CREATE TABLE t (id INTEGER);\n", encoding="utf-8")
    monkeypatch.setattr(db_module, "MIGRATIONS_DIR", migrations)
    database = Database(tmp_path / "flow.db")
    database.init()

    backups = tmp_path / "backups"
    backups.mkdir()
    for stamp in ("20200101T000000Z", "20210101T000000Z", "20220101T000000Z"):
        (backups / f"flow-v1-{stamp}.db").write_bytes(b"old")
    (migrations / "002_more.sql").write_text("CREATE TABLE u (id INTEGER);\n", encoding="utf-8")
    database.init()

    kept = sorted(p.name for p in backups.iterdir())
    assert len(kept) == db_module.BACKUPS_KEPT
    assert "flow-v1-20200101T000000Z.db" not in kept
    database.close_all()
