"""Scrobbling to ListenBrainz (G3), against a local fake ListenBrainz.

With no token Flow makes no outbound request at all. With one, a counted
play is sent with its title, artist, album, length and time; a failed send
is kept and retried later without blocking anything; a refused token stops
the sending; turning it off drops what was waiting. The token is never sent
back by the API."""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import scrobble
from tests.audio_fixtures import make_mp3

TOKEN = "fake-token-0123456789"


@pytest.fixture
def library(music):
    make_mp3(music / "A" / "1.mp3", title="Song One", artist="The Band", album="First")
    make_mp3(music / "A" / "2.mp3", title="Song Two", artist="The Band", album="First")
    return music


class FakeListenBrainz:
    def __init__(self):
        self.received: list[dict] = []
        self.submit_status = 200
        self.valid_tokens = {TOKEN}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _token_ok(self):
                return self.headers.get("Authorization") in {f"Token {t}" for t in outer.valid_tokens}

            def do_GET(self):  # /1/validate-token
                self.send_response(200 if self._token_ok() else 401)
                self.end_headers()

            def do_POST(self):  # /1/submit-listens
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if not self._token_ok():
                    self.send_response(401)
                else:
                    outer.received.append(body)
                    self.send_response(outer.submit_status)
                self.end_headers()

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def fake(monkeypatch):
    from app import config

    lb = FakeListenBrainz()
    monkeypatch.setattr(config, "LISTENBRAINZ_URL", lb.url)
    yield lb
    lb.close()


def _ids(client):
    return {t["title"]: t["id"] for t in client.get("/api/tracks").json()["items"]}


def _play(client, track_id):
    assert client.patch("/api/queue", json={"played_track_id": track_id}).status_code == 200


def test_no_token_means_no_outbound_request(client, library, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("Flow made an outbound request with no token set")

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    _play(client, _ids(client)["Song One"])
    db = client.app.state.db
    assert db.connect().execute("SELECT COUNT(*) c FROM listenbrainz_queue").fetchone()["c"] == 0
    assert scrobble.send_due(db) == 0
    assert client.get("/api/settings").json()["listenbrainz"] == {
        "enabled": False, "refused": False, "sent": 0, "waiting": 0,
    }


def test_a_counted_play_is_sent_and_the_token_never_comes_back(client, library, fake):
    r = client.put("/api/listenbrainz", json={"token": TOKEN})
    assert r.status_code == 200 and r.json()["enabled"] is True
    assert TOKEN not in client.get("/api/settings").text
    client.app.state.scrobbler.stop()  # the test drives the sending itself
    _play(client, _ids(client)["Song One"])
    db = client.app.state.db
    assert scrobble.send_due(db) == 1
    (sent,) = fake.received
    assert sent["listen_type"] == "single"
    (listen,) = sent["payload"]
    meta = listen["track_metadata"]
    assert (meta["artist_name"], meta["track_name"], meta["release_name"]) == (
        "The Band", "Song One", "First",
    )
    assert meta["additional_info"]["submission_client"] == "Flow"
    assert meta["additional_info"]["duration_ms"] > 0
    assert abs(listen["listened_at"] - time.time()) < 60
    assert client.get("/api/settings").json()["listenbrainz"]["sent"] == 1


def test_a_failed_send_is_kept_and_retried_later(client, library, fake):
    client.put("/api/listenbrainz", json={"token": TOKEN})
    client.app.state.scrobbler.stop()
    db = client.app.state.db
    fake.submit_status = 503
    _play(client, _ids(client)["Song One"])
    assert scrobble.send_due(db) == 0
    row = db.connect().execute("SELECT attempts, next_try FROM listenbrainz_queue").fetchone()
    assert row["attempts"] == 1 and row["next_try"] > time.time()
    assert scrobble.send_due(db) == 0  # not due yet: no request
    assert len(fake.received) == 1
    fake.submit_status = 200
    assert scrobble.send_due(db, now=time.time() + 3600) == 1
    assert client.get("/api/settings").json()["listenbrainz"]["waiting"] == 0


def test_an_unreachable_listenbrainz_keeps_the_listen(client, library, fake, monkeypatch):
    from app import config

    client.put("/api/listenbrainz", json={"token": TOKEN})
    client.app.state.scrobbler.stop()
    monkeypatch.setattr(config, "LISTENBRAINZ_URL", "http://127.0.0.1:9")  # nothing listens there
    _play(client, _ids(client)["Song Two"])
    assert scrobble.send_due(client.app.state.db) == 0
    assert client.get("/api/settings").json()["listenbrainz"]["waiting"] == 1


def test_a_refused_token_stops_the_sending(client, library, fake):
    client.put("/api/listenbrainz", json={"token": TOKEN})
    client.app.state.scrobbler.stop()
    fake.valid_tokens = set()  # revoked on ListenBrainz
    _play(client, _ids(client)["Song One"])
    assert scrobble.send_due(client.app.state.db) == 0
    status = client.get("/api/settings").json()["listenbrainz"]
    assert status["refused"] is True
    _play(client, _ids(client)["Song Two"])  # not even queued now
    assert client.get("/api/settings").json()["listenbrainz"]["waiting"] == 1


def test_saving_checks_the_token_and_off_drops_the_queue(client, library, fake):
    r = client.put("/api/listenbrainz", json={"token": "wrong"})
    assert r.status_code == 400
    assert client.get("/api/settings").json()["listenbrainz"]["enabled"] is False
    client.put("/api/listenbrainz", json={"token": TOKEN})
    client.app.state.scrobbler.stop()
    _play(client, _ids(client)["Song One"])
    off = client.put("/api/listenbrainz", json={"token": None}).json()
    assert off == {"enabled": False, "refused": False, "sent": 0, "waiting": 0}


def test_the_background_sender_sends_without_blocking_the_play(client, library, fake):
    client.put("/api/listenbrainz", json={"token": TOKEN})
    _play(client, _ids(client)["Song One"])
    deadline = time.monotonic() + 5
    while not fake.received:
        assert time.monotonic() < deadline, "the sender never sent the listen"
        time.sleep(0.05)
