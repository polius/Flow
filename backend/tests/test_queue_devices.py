"""One queue, several devices (P3): the device that starts, plays or takes
over the queue holds it; another device's writes are refused with 409
instead of silently overwriting; shuffle and repeat travel with it."""

from __future__ import annotations

import pytest

from tests.audio_fixtures import make_mp3


@pytest.fixture
def library(music):
    for i in range(4):
        make_mp3(music / "A" / f"{i}.mp3", title=f"Song {i}", artist="X", album="A")
    return music


def _ids(client):
    return [t["id"] for t in client.get("/api/tracks").json()["items"]]


def _put(client, ids, device, **extra):
    return client.put(
        "/api/queue",
        params={"minimal": 1},
        json={"track_ids": ids, "order": list(range(len(ids))), "order_pos": 0, "device": device, **extra},
    )


def test_another_device_is_told_instead_of_overwriting(client, library):
    ids = _ids(client)
    assert _put(client, ids, "laptop").status_code == 200
    assert client.patch("/api/queue", json={"position": 5, "device": "laptop"}).status_code == 200
    # The phone starts playing: a new queue is the phone's.
    assert _put(client, ids[:2], "phone").status_code == 200
    # The laptop's next playhead save is refused, and changes nothing.
    r = client.patch("/api/queue", json={"position": 9, "order_pos": 1, "device": "laptop"})
    assert r.status_code == 409
    snap = client.get("/api/queue").json()
    assert [t["id"] for t in snap["items"]] == ids[:2] and snap["position"] == 0
    # Take over: the laptop sends its whole queue, and now the phone is told.
    assert _put(client, ids, "laptop").status_code == 200
    assert client.patch("/api/queue", json={"position": 1, "device": "phone"}).status_code == 409
    assert len(client.get("/api/queue").json()["items"]) == len(ids)


def test_a_write_without_a_device_is_let_through(client, library):
    """Older clients (an open tab from before the upgrade) name no device."""
    ids = _ids(client)
    _put(client, ids, "laptop")
    assert client.patch("/api/queue", json={"position": 3}).status_code == 200


def test_shuffle_and_repeat_travel_with_the_queue(client, library):
    ids = _ids(client)
    _put(client, ids, "laptop", shuffle=True, repeat="all")
    snap = client.get("/api/queue").json()
    assert snap["shuffle"] is True and snap["repeat"] == "all"
    client.patch("/api/queue", json={"repeat": "one", "device": "laptop"})
    assert client.get("/api/queue").json()["repeat"] == "one"
    played = client.post("/api/queue", json={"track_ids": ids, "start": 0, "shuffle": False, "device": "phone"})
    assert played.status_code == 200 and played.json()["shuffle"] is False
    assert played.json()["repeat"] == "one"  # repeat is a listener's setting: kept
