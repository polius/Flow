"""The server-truth play queue and played_at stamping."""

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
    # equal the full filtered listing, in its order.
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
    # it must not clamp into "the last track"; the stored value stands
    # until the PUT brings them together.
    assert r.json()["order_pos"] == 0
    assert client.get("/api/queue").json()["order_pos"] == 0

    # In-range values apply normally.
    client.patch("/api/queue", json={"order_pos": 2})
    assert client.get("/api/queue").json()["order_pos"] == 2

    # An empty plan accepts only the idle convention.
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
    # survive it exactly like `favorite`.
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


# ---- Origin ----


def test_post_records_origin_and_get_returns_it(client, library):
    ids = _ids(client)
    r = client.post(
        "/api/queue",
        json={
            "track_ids": ids,
            "start": 0,
            "origin": {"kind": "album", "label": "Album A", "href": "/albums/1"},
        },
    )
    assert r.status_code == 200
    assert r.json()["origin"] == {
        "kind": "album",
        "label": "Album A",
        "href": "/albums/1",
    }
    assert client.get("/api/queue").json()["origin"]["label"] == "Album A"


def test_post_without_origin_stores_none(client, library):
    r = client.post("/api/queue", json={"track_ids": _ids(client), "start": 0})
    assert r.status_code == 200
    assert r.json()["origin"] is None


def test_post_rejects_unknown_origin_kind(client, library):
    r = client.post(
        "/api/queue",
        json={
            "track_ids": _ids(client),
            "origin": {"kind": "playlist?", "label": "x"},
        },
    )
    assert r.status_code == 422


def test_put_mirrors_origin_and_heal_preserves_it(client, library):
    ids = _ids(client)
    client.post(
        "/api/queue",
        json={
            "track_ids": ids,
            "origin": {"kind": "filter", "label": "Your Library", "href": "/tracks"},
        },
    )

    # The plan mirror carries the origin unchanged — queue edits never
    # rewrite where the queue came from.
    client.put(
        "/api/queue",
        json={
            "track_ids": ids,
            "order": list(range(len(ids))),
            "order_pos": 0,
            "position": 0,
            "origin": {"kind": "filter", "label": "Your Library", "href": "/tracks"},
        },
    )

    # A healing read (a track removed underneath the queue) rewrites the
    # stored session — the origin must survive the rewrite.
    conn = client.app.state.db.connect()
    conn.execute("DELETE FROM tracks WHERE id = ?", (ids[0],))
    conn.commit()
    got = client.get("/api/queue").json()
    assert got["origin"] == {
        "kind": "filter",
        "label": "Your Library",
        "href": "/tracks",
    }
    assert len(got["items"]) == len(ids) - 1


def test_get_degrades_corrupt_origin_to_none(client, library):
    client.post("/api/queue", json={"track_ids": _ids(client), "start": 0})
    conn = client.app.state.db.connect()
    conn.execute("UPDATE queue_state SET origin = '{not json' WHERE id = 0")
    conn.commit()
    got = client.get("/api/queue").json()
    assert got["origin"] is None
    assert len(got["items"]) > 0  # the session itself is untouched


# ---- write-lock resilience ----


def test_write_transaction_retries_then_succeeds(db):
    """A locked attempt is retried with backoff; the write lands on the
    first free window instead of surfacing `database is locked` as a 500."""
    import sqlite3 as _sqlite3

    from app.routers.queue import _write_transaction

    conn = db.connect()
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise _sqlite3.OperationalError("database is locked")
        conn.execute(
            "UPDATE queue_state SET updated_at = ? WHERE id = 0", ("2026-10-03",)
        )
        conn.commit()
        return "ok"

    assert _write_transaction(conn, flaky) == "ok"
    assert calls["n"] == 3


def test_write_transaction_raises_through_non_lock_errors(db):
    """A genuine failure (not a lock) is not retried — it propagates."""
    import sqlite3 as _sqlite3

    from app.routers.queue import _write_transaction

    conn = db.connect()

    def broken():
        raise _sqlite3.OperationalError("no such table: nothing")

    with pytest.raises(_sqlite3.OperationalError, match="no such table"):
        _write_transaction(conn, broken)


def test_retry_locked_exhausts_deadline_and_raises(db):
    """A lock held past the deadline re-raises — honest failure, not a hang."""
    import sqlite3 as _sqlite3

    from app.db import retry_locked

    conn = db.connect()

    def always_locked():
        raise _sqlite3.OperationalError("database is locked")

    with pytest.raises(_sqlite3.OperationalError, match="locked"):
        retry_locked(conn, always_locked, deadline=0.2)


def test_playhead_write_lands_while_another_writer_holds_the_lock(db):
    """The reported failure mode: another writer holds the WAL write lock
    while the queue mirror writes its playhead. The write waits out the
    window and lands — no `database is locked` exception surfaces."""
    import sqlite3 as _sqlite3
    import threading
    import time as _time

    from app.routers.queue import _write_transaction

    conn = db.connect()
    locked = threading.Event()
    # A second connection plays the long-writer role (the scanner's). It
    # lives entirely in its own thread (sqlite3 objects are thread-bound).
    def hold_and_release():
        b = _sqlite3.connect(db.path)
        b.execute("PRAGMA busy_timeout=50")
        b.execute("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)")
        b.commit()
        b.execute("BEGIN IMMEDIATE")
        b.execute("INSERT INTO lock_probe VALUES (1)")
        locked.set()
        _time.sleep(1.0)
        b.rollback()
        b.close()

    releaser = threading.Thread(target=hold_and_release)
    releaser.start()
    assert locked.wait(2.0)

    start = _time.monotonic()
    try:
        _write_transaction(
            conn,
            lambda: (
                conn.execute(
                    "UPDATE queue_state SET updated_at = ? WHERE id = 0", ("held",)
                ),
                conn.commit(),
            ),
        )
    finally:
        releaser.join()
    assert _time.monotonic() - start >= 0.9

    row = conn.execute("SELECT updated_at FROM queue_state WHERE id = 0").fetchone()
    assert row["updated_at"] == "held"
