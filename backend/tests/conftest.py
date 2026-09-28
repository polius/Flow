import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

# Keep any accidental app.main module-level singleton away from repo-local ./.data
os.environ.setdefault("FLOW_DATA_DIR", str(BACKEND_DIR / ".test-data"))
os.environ.setdefault("FLOW_MUSIC_DIR", str(BACKEND_DIR / ".test-music"))


class NullBus:
    def publish(self, event: dict) -> None:  # pragma: no cover
        pass


@pytest.fixture
def db(tmp_path):
    from app.db import Database

    database = Database(tmp_path / "test.db")
    database.init()
    yield database
    database.close_thread()


@pytest.fixture
def music(tmp_path):
    library = tmp_path / "music"
    library.mkdir()
    return library


@pytest.fixture
def scanner(db, music):
    from app.scanner import LibraryScanner

    return LibraryScanner(db, music, NullBus())


@pytest.fixture
def conn(db):
    return db.connect()


@pytest.fixture
def client(monkeypatch, tmp_path, library):
    """TestClient with lifespan; background scans disabled, library scanned
    synchronously so tests are deterministic. Depends on `library` (not
    `music`) so files exist before the scan runs."""
    from fastapi.testclient import TestClient

    from app import config
    from app.main import create_app

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "api.db")
    monkeypatch.setattr(config, "MUSIC_DIR", library)
    monkeypatch.setattr(config, "DIST_DIR", None)
    app = create_app()
    monkeypatch.setattr(app.state.scanner, "start_scan", lambda trigger: False)
    with TestClient(app) as c:
        app.state.scanner.run_scan("test")
        yield c
