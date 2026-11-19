"""The watcher's first look at the library (a polling observer reads every
folder: seconds on a big library) must not hold the server back. It ran
before the API answered, which was a 502 for 4 s at 10,000 songs."""

import threading
import time


def test_server_answers_while_the_watcher_still_looks(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from app import config, main

    looking = threading.Event()
    done = threading.Event()

    class SlowWatcher:
        def __init__(self, *args):
            pass

        def start(self):
            looking.set()
            done.wait(10)

        def stop(self):
            done.set()

    music = tmp_path / "music"
    music.mkdir()
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "api.db")
    monkeypatch.setattr(config, "MUSIC_DIR", music)
    monkeypatch.setattr(config, "DIST_DIR", None)
    monkeypatch.setattr(main, "LibraryWatcher", SlowWatcher)
    app = main.create_app()
    began = time.monotonic()
    with TestClient(app) as c:
        assert time.monotonic() - began < 5, "startup waited for the watcher"
        assert looking.wait(5)
        assert not done.is_set()  # still looking, and the API answers
        assert c.get("/api/health").status_code == 200
    assert done.is_set()  # shutdown stopped it
    app.state.db.close_all()
