"""The server-truth play queue (UX review Part 4.0) and played_at
(UX review Part 4.1) — DESIGN.md §32."""

from __future__ import annotations

import os

import pytest
from tests.audio_fixtures import make_mp3


@pytest.fixture
def library(music):
    # 18 tracks across two albums — enough for filters, sorts, and orders.
    for i in range(1, 13):
        make_mp3(
            music / "Album A" / f"{i:02d} - Song {i:02d}.mp3",
            title=f"Song {i:02d}",
            artist="Artist A",
            album="Album A",
            track=f"{i}/12",
        )
    for i in range(1, 7):
        make_mp3(
            music / "Album B" / f"{i:02d} - Other {i:02d}.mp3",
            title=f"Other {i:02d}",
            artist="Artist B",
            album="Album B",
            track=f"{i}/6",
        )
    return music


def _ids(client) -> list[int]:
    data = client.get("/api/tracks", params={"sort": "title", "limit": 1000}).json()
    return [t["id"] for t in data["items"]]


def test_get_queue_empty_on_fresh_server(client, library):
    snap = client.get("/api/queue").json()
    assert snap["items"] == []
    assert snap["order"] == []
    assert snap["order_pos"] == -1


def test_post_track_ids_then_get_roundtrip(client, library):
    ids = _ids(client)
    r = client.post("/api/queue", json={"track_ids": ids, "start": 2})
    assert r.status_code == 200
    snap = r.json()
    assert [t["id"] for t in snap["items"]] == ids
    assert snap["order"] == list(range(len(ids)))
    assert snap["order_pos"] == 2
    assert snap["position"] == 0
    assert snap["updated_at"] is not None

    got = client.get("/api/queue").json()
    assert [t["id"] for t in got["items"]] == ids
    assert got["order"] == list(range(len(ids)))
    assert got["order_pos"] == 2


def test_post_filter_resolves_whole_view_in_listing_order(client, library):
    # The queue POST has no pagination of its own: the resolved list must
    # equal the full filtered listing, in its order (§1.2 has no page to
    # truncate to — structurally, not by fetched-in-time).
    listed = [
        t["id"]
        for t in client.get(
            "/api/tracks",
            params={"sort": "title", "dir": "desc", "limit": 1000},
        ).json()["items"]
    ]
    r = client.post("/api/queue", json={"sort": "title", "dir": "desc"})
    assert r.status_code == 200
    assert [t["id"] for t in r.json()["items"]] == listed

    filtered = client.post(
        "/api/queue", json={"q": "Other", "sort": "album"}
    ).json()
    assert len(filtered["items"]) == 6


def test_post_shuffle_builds_permutation_anchored_at_start(client, library):
    ids = _ids(client)
    snap = client.post(
        "/api/queue", json={"track_ids": ids, "shuffle": True, "start": 3}
    ).json()
    assert sorted(snap["order"]) == list(range(len(ids)))
    assert snap["order"][0] == 3
    assert snap["order_pos"] == 0


def test_post_rejects_ambiguous_or_empty_bodies(client, library):
    ids = _ids(client)
    assert client.post("/api/queue", json={"track_ids": ids, "q": "x"}).status_code == 422
    assert client.post("/api/queue", json={"q": "nothing-matches-this"}).status_code == 422
    assert client.post(
        "/api/queue", json={"track_ids": [ids[0], 999999]}
    ).status_code == 422


def test_put_mirror_and_patch_playhead_roundtrip(client, library):
    ids = _ids(client)
    client.post("/api/queue", json={"track_ids": ids, "start": 0})

    new_order = list(reversed(range(len(ids))))
    r = client.put(
        "/api/queue",
        json={"track_ids": ids, "order": new_order, "order_pos": 1, "position": 2.5},
    )
    assert r.status_code == 200
    snap = r.json()
    assert snap["order"] == new_order
    assert snap["order_pos"] == 1
    assert snap["position"] == 2.5

    client.patch("/api/queue", json={"order_pos": 4, "position": 1.5})
    got = client.get("/api/queue").json()
    assert got["order_pos"] == 4
    assert got["position"] == 1.5


def test_put_rejects_non_permutation_order(client, library):
    ids = _ids(client)
    r = client.put(
        "/api/queue",
        json={"track_ids": ids[:3], "order": [0, 0, 1], "order_pos": 0},
    )
    assert r.status_code == 422
    # The rejected mirror must not have touched the stored queue.
    assert client.get("/api/queue").json()["items"] == []


def test_patch_ignores_out_of_range_playhead(client, library):
    ids = _ids(client)
    client.post("/api/queue", json={"track_ids": ids[:3], "start": 0})
    r = client.patch("/api/queue", json={"order_pos": 99, "position": 1.0})
    assert r.status_code == 200
    # An out-of-range playhead belongs to a plan that isn't mirrored yet —
    # it must not clamp into "the last track" (a pointer the writer never
    # meant); the stored value stands until the PUT brings them together.
    assert r.json()["order_pos"] == 0
    assert client.get("/api/queue").json()["order_pos"] == 0

    # In-range values apply normally.
    client.patch("/api/queue", json={"order_pos": 2})
    assert client.get("/api/queue").json()["order_pos"] == 2

    # An empty plan accepts only the idle convention (§23.6).
    client.put("/api/queue", json={"track_ids": [], "order": [], "order_pos": -1})
    r = client.patch("/api/queue", json={"order_pos": 5})
    assert r.json()["order_pos"] == -1


def test_patch_stamps_played_at_on_the_reported_track(client, library):
    ids = _ids(client)
    client.post("/api/queue", json={"track_ids": ids, "start": 0})

    r = client.patch(
        "/api/queue",
        json={"order_pos": 0, "position": 0.5, "played_track_id": ids[0]},
    )
    assert r.status_code == 200
    assert client.get(f"/api/tracks/{ids[0]}").json()["played_at"] is not None
    # No counts anywhere — one timestamp, and only on the track that played.
    assert client.get(f"/api/tracks/{ids[1]}").json()["played_at"] is None


def test_played_at_survives_a_rescan(client, library):
    ids = _ids(client)
    target = ids[0]
    client.patch("/api/queue", json={"played_track_id": target})
    before = client.get(f"/api/tracks/{target}").json()["played_at"]

    # Re-tag that file underneath (same path, forced-new mtime): the scanner
    # takes its UPDATE path with a fixed column list — played_at must
    # survive it exactly like `favorite` (§15.2's rule, one more column).
    target_path = library / "Album B" / "01 - Other 01.mp3"
    make_mp3(
        target_path,
        title="Other 01 (Remaster)",
        artist="Artist B",
        album="Album B",
        track="1/6",
    )
    st = target_path.stat()
    os.utime(target_path, (st.st_atime, st.st_mtime + 10))

    client.app.state.scanner.run_scan("rescan")

    after = client.get(f"/api/tracks/{target}").json()
    assert after["played_at"] == before
    assert after["title"] == "Other 01 (Remaster)"  # the tag change did land


def test_get_heals_after_library_removal(client, library):
    ids = _ids(client)
    client.post("/api/queue", json={"track_ids": ids, "start": 2})

    victim = ids[1]
    conn = client.app.state.db.connect()
    conn.execute("DELETE FROM tracks WHERE id = ?", (victim,))
    conn.commit()

    got = client.get("/api/queue").json()
    got_ids = [t["id"] for t in got["items"]]
    assert got_ids == [i for i in ids if i != victim]
    assert sorted(got["order"]) == list(range(len(got_ids)))
    # The playhead still points at the track it pointed at before.
    assert got["items"][got["order"][got["order_pos"]]]["id"] == ids[2]

    # And the healed form is what's stored now (the read rewrote it).
    again = client.get("/api/queue").json()
    assert again["order"] == got["order"]
