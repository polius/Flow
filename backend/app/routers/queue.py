"""The server-truth play queue (UX review Part 4.0, DESIGN.md §32).

The client store remains the source of *UI* truth — every click still lands
instantly in local state — and this router is the source of *truth* truth:

- POST /api/queue  "play this view": the whole filter resolves server-side,
  in one query. There is no page for the queue to be silently truncated to
  (§1.2, for good), and the session exists on the server from birth.
- PUT /api/queue   the client's plan mirror, debounced like the §29
  localStorage writer — so reloads and second browsers see the same queue.
- PATCH /api/queue the playhead, at the §29 cadence (3 s throttle + a
  pagehide flush), stamping played_at (§4.1) on real playback starts.
- GET /api/queue   the restore. Self-heals: queue entries whose track has
  been removed from the library cascade away (like playlists), stale
  play-order entries are dropped, and the snapshot is rewritten canonically.

Storage is two tiny tables (migration 006): queue_items (dense positions)
and the queue_state singleton (play order as JSON + playhead). The queue is
whole-snapshot state, not a log — replaces are one transaction.
"""

from __future__ import annotations

import json
import random
import sqlite3
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from app.routers.library import (
    TRACK_SELECT,
    TRACK_SORTS,
    _directed,
    track_filter_where,
    track_out,
)
from app.schemas import (
    QueuePatchIn,
    QueuePlayheadOut,
    QueuePlayIn,
    QueuePutIn,
    QueueSnapshot,
)

router = APIRouter(tags=["queue"])

# The queue's tracks, carrying their queue position and track id. Same row
# shape as TRACK_SELECT plus the two queue columns — track_out ignores them.
_QUEUE_SELECT = TRACK_SELECT.replace(
    "SELECT ",
    "SELECT qi.position AS queue_position, qi.track_id AS queue_track_id, ",
    1,
).replace(
    "FROM tracks t",
    "FROM queue_items qi JOIN tracks t ON t.id = qi.track_id",
    1,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_transaction(conn: sqlite3.Connection, fn):
    """Run a queue write, retrying briefly while the database is busy.

    The queue's writes are tiny and routine (the §32 mirror's 3 s playhead
    cadence) — but the scanner's reconcile/analyze transactions hold the
    WAL write lock for seconds at a time, and a fire-and-forget mirror that
    500s through every scan would be noise, not resilience. Bounded retries
    land as soon as the scanner's commit gap appears; exhaustion keeps the
    error (honest) instead of writing partial state."""
    last: sqlite3.OperationalError | None = None
    for attempt in range(4):
        try:
            return fn()
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc) and "busy" not in str(exc):
                raise
            last = exc
            time.sleep(0.3 * (attempt + 1))
    raise last  # type: ignore[misc]


def _chunks(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _load_state(conn: sqlite3.Connection) -> sqlite3.Row:
    state = conn.execute("SELECT * FROM queue_state WHERE id = 0").fetchone()
    if state is None:  # defensive: the migration seeds the singleton
        conn.execute("INSERT INTO queue_state (id) VALUES (0)")
        conn.commit()
        state = conn.execute("SELECT * FROM queue_state WHERE id = 0").fetchone()
    return state


def _read_snapshot(conn: sqlite3.Connection) -> QueueSnapshot:
    """Read the stored session, healing it if the library moved underneath
    (removed tracks cascade out of queue_items; play_order entries and the
    playhead are renumbered to match). The healed form is written back so
    storage stays canonical."""
    state = _load_state(conn)
    rows = conn.execute(
        f"{_QUEUE_SELECT} ORDER BY qi.position"
    ).fetchall()
    items = [track_out(r) for r in rows]

    try:
        order = json.loads(state["play_order"] or "[]")
        if not isinstance(order, list):
            order = []
    except ValueError:
        order = []

    live = {r["queue_position"]: new for new, r in enumerate(rows)}
    healed_order = [live[p] for p in order if isinstance(p, int) and p in live]

    order_pos = state["order_pos"]
    if not isinstance(order_pos, int):
        order_pos = -1
    current = order[order_pos] if 0 <= order_pos < len(order) else None
    if current is not None and current in live:
        # The same track, at its new index in the healed play order.
        healed_pos = healed_order.index(live[current])
    elif order_pos == -1 or not healed_order:
        healed_pos = -1  # idle queue (§23.6), or nothing left to point at
    else:
        # The playhead's own entry died: clamp the index like the client's
        # §29 restore clamps, so the pointer stays inside the plan.
        healed_pos = min(order_pos, len(healed_order) - 1)

    position = float(state["position"] or 0.0)
    if items and 0 <= healed_pos < len(healed_order):
        position = max(0.0, min(position, items[healed_order[healed_pos]].duration))

    updated_at = state["updated_at"]
    if (
        len(healed_order) != len(order)
        or [r["queue_position"] for r in rows] != list(range(len(rows)))
        or healed_pos != order_pos
    ):
        updated_at = _write_transaction(
            conn,
            lambda: _write_snapshot(
                conn,
                track_ids=[r["queue_track_id"] for r in rows],
                order=healed_order,
                order_pos=healed_pos,
                position=position,
            ),
        )

    return QueueSnapshot(
        items=items,
        order=healed_order,
        order_pos=healed_pos,
        position=position,
        updated_at=updated_at,
    )


def _write_snapshot(
    conn: sqlite3.Connection,
    *,
    track_ids: list[int],
    order: list[int],
    order_pos: int,
    position: float,
) -> str:
    """Replace the whole stored session in one transaction. Returns the
    timestamp it wrote."""
    updated_at = _now()
    conn.execute("DELETE FROM queue_items")
    conn.executemany(
        "INSERT INTO queue_items (position, track_id) VALUES (?, ?)",
        list(enumerate(track_ids)),
    )
    conn.execute(
        "UPDATE queue_state SET play_order = ?, order_pos = ?, position = ?, "
        "updated_at = ? WHERE id = 0",
        (json.dumps(order), order_pos, float(position), updated_at),
    )
    conn.commit()
    return updated_at


def _build_order(count: int, shuffle: bool, start: int) -> tuple[list[int], int]:
    """The play order for a fresh queue — the client's buildOrder (§29),
    server-side: identity honoring `start`, or a shuffle anchored there."""
    if count == 0:
        return [], -1
    start = min(max(start, 0), count - 1)
    if not shuffle:
        return list(range(count)), start
    rest = [i for i in range(count) if i != start]
    random.shuffle(rest)
    return [start, *rest], 0


@router.get("/api/queue", response_model=QueueSnapshot)
def get_queue(request: Request) -> QueueSnapshot:
    """The stored session, or an empty one when none exists (first run).
    The client falls back to its localStorage snapshot when this is empty
    or unreachable — the server is the truth, not a single point of failure."""
    conn = request.app.state.db.connect()
    return _read_snapshot(conn)


@router.post("/api/queue", response_model=QueueSnapshot)
def play_queue(request: Request, body: QueuePlayIn) -> QueueSnapshot:
    """"Play this view" (§4.0): replace the queue with the WHOLE filter —
    resolved and ordered server-side — and start at `start`. The response is
    the canonical snapshot; the client adopts it wholesale."""
    conn = request.app.state.db.connect()

    has_filter = any(
        getattr(body, f) is not None
        for f in ("q", "artist_id", "album_id", "review", "favorite", "genre_id")
    )
    if body.track_ids is not None and has_filter:
        raise HTTPException(
            status_code=422, detail="Provide track_ids or a filter, not both"
        )

    if body.track_ids is not None:
        wanted = list(dict.fromkeys(body.track_ids))  # dedupe, keep order
        existing: set[int] = set()
        for chunk in _chunks(wanted, 500):
            marks = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"SELECT id FROM tracks WHERE id IN ({marks})", chunk
            ).fetchall()
            existing.update(r["id"] for r in rows)
        missing = len(wanted) - len(existing)
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"{missing} of {len(wanted)} tracks no longer exist",
            )
        # The existence check scans the table — rebuild the caller's order.
        ids = [tid for tid in wanted if tid in existing]
    else:
        clause, params = track_filter_where(
            q=body.q,
            artist_id=body.artist_id,
            album_id=body.album_id,
            review=body.review,
            favorite=body.favorite,
            genre_id=body.genre_id,
        )
        desc = body.dir == "desc"
        order_sql = TRACK_SORTS.get(body.sort, TRACK_SORTS["title"])
        rows = conn.execute(
            f"SELECT t.id FROM tracks t "
            f"LEFT JOIN artists ar ON ar.id = t.artist_id "
            f"LEFT JOIN albums al ON al.id = t.album_id {clause} "
            f"ORDER BY {_directed(order_sql, desc)}, "
            f"t.title COLLATE NOCASE {'DESC' if desc else ''}",
            params,
        ).fetchall()
        ids = [r["id"] for r in rows]

    if not ids:
        raise HTTPException(status_code=422, detail="No tracks match")

    play_order, order_pos = _build_order(len(ids), body.shuffle, body.start)
    _write_transaction(conn, lambda: _load_state(conn))  # seeds the singleton
    _write_transaction(
        conn,
        lambda: _write_snapshot(
            conn, track_ids=ids, order=play_order, order_pos=order_pos, position=0.0
        ),
    )
    return _read_snapshot(conn)


@router.put("/api/queue", response_model=QueueSnapshot)
def put_queue(request: Request, body: QueuePutIn) -> QueueSnapshot:
    """The plan mirror (§32). Whole-snapshot replace, same as POST but with a
    client-built play order. Validation is honest, not defensive theater: a
    malformed order is a 422 the client answers by falling back to its
    localStorage-only persistence, never by corrupting the server's copy."""
    conn = request.app.state.db.connect()
    n = len(body.track_ids)
    if sorted(body.order) != list(range(n)):
        raise HTTPException(
            status_code=422, detail="order must be a permutation of 0..n-1"
        )
    order_pos = body.order_pos
    if order_pos < -1 or order_pos >= max(n, 1):
        order_pos = min(max(order_pos, -1), n - 1)
    _write_transaction(
        conn,
        lambda: _write_snapshot(
            conn,
            track_ids=body.track_ids,
            order=body.order,
            order_pos=order_pos,
            position=max(0.0, body.position),
        ),
    )
    return _read_snapshot(conn)


@router.patch("/api/queue", response_model=QueuePlayheadOut)
def patch_queue(request: Request, body: QueuePatchIn) -> QueuePlayheadOut:
    """The playhead (§29 cadence), plus §4.1's played_at stamp: a real
    playback start reports its track id and the server records it — carried
    explicitly, never derived from stored state, so a mirror PUT still in
    flight cannot mis-stamp. One transaction under the busy-retry."""
    conn = request.app.state.db.connect()
    state = _load_state(conn)

    # The target values are computable up front (reads); the transaction is
    # the two writes under one retry window.
    n = conn.execute("SELECT COUNT(*) AS c FROM queue_items").fetchone()["c"]
    order_pos = state["order_pos"]
    if body.order_pos is not None:
        # An out-of-range playhead means the writer's plan isn't mirrored yet
        # (its PUT is in flight) — it does NOT mean "the last track". Ignore
        # it and let the mirror bring plan and playhead together; clamping
        # would invent a pointer into an order the writer never meant.
        if -1 <= body.order_pos < n:
            order_pos = body.order_pos
    position = (
        max(0.0, body.position)
        if body.position is not None
        else float(state["position"] or 0.0)
    )
    updated_at = _now()

    def _apply() -> None:
        if body.played_track_id is not None:
            conn.execute(
                "UPDATE tracks SET played_at = ? WHERE id = ?",
                (_now(), body.played_track_id),
            )
        conn.execute(
            "UPDATE queue_state SET order_pos = ?, position = ?, updated_at = ? "
            "WHERE id = 0",
            (order_pos, position, updated_at),
        )
        conn.commit()

    # A scan's write transaction must not thin the §4.1 record either —
    # stamp and playhead share one retry window.
    _write_transaction(conn, _apply)
    return QueuePlayheadOut(order_pos=order_pos, position=position, updated_at=updated_at)
