"""The server-truth play queue: whole-snapshot state over queue_items + queue_state."""

from __future__ import annotations

import json
import random
import sqlite3
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from app.db import retry_locked
from app.routers.library import (
    TRACK_SELECT,
    TRACK_SORTS,
    _directed,
    track_filter_where,
    track_out,
)
from app.schemas import (
    QueueOrigin,
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
    """Run a queue write, retrying with backoff while the database is busy.

    The ~20 s deadline out-waits any scanner lock window (it commits per
    file and never holds a transaction across an ffmpeg run); exhaustion
    keeps the error instead of writing partial state."""
    return retry_locked(conn, fn, deadline=20.0)


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


def _read_origin(state: sqlite3.Row) -> QueueOrigin | None:
    """The stored origin, defensively parsed: a corrupt value costs the
    label, never the session (degrades to no "Playing from" line)."""
    raw = state["origin"] if "origin" in state.keys() else None
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        kind = parsed.get("kind")
        if kind not in ("album", "artist", "playlist", "filter", "shuffle-all", "manual"):
            return None
        return QueueOrigin(
            kind=kind,
            label=parsed.get("label"),
            href=parsed.get("href"),
        )
    except (ValueError, AttributeError):
        return None


def _read_snapshot(conn: sqlite3.Connection) -> QueueSnapshot:
    """Read the stored session, healing entries whose tracks were removed
    from the library; the healed form is written back so storage stays
    canonical."""
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
        healed_pos = -1  # idle queue, or nothing left to point at
    else:
        # The playhead's own entry died: clamp the index so the pointer
        # stays inside the plan.
        healed_pos = min(order_pos, len(healed_order) - 1)

    position = float(state["position"] or 0.0)
    if items and 0 <= healed_pos < len(healed_order):
        position = max(0.0, min(position, items[healed_order[healed_pos]].duration))

    origin = _read_origin(state)
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
                origin=origin,
            ),
        )

    return QueueSnapshot(
        items=items,
        order=healed_order,
        order_pos=healed_pos,
        position=position,
        origin=origin,
        updated_at=updated_at,
    )


def _write_snapshot(
    conn: sqlite3.Connection,
    *,
    track_ids: list[int],
    order: list[int],
    order_pos: int,
    position: float,
    origin: QueueOrigin | None = None,
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
        "origin = ?, updated_at = ? WHERE id = 0",
        (
            json.dumps(order),
            order_pos,
            float(position),
            origin.model_dump_json() if origin is not None else None,
            updated_at,
        ),
    )
    conn.commit()
    return updated_at


def _build_order(count: int, shuffle: bool, start: int) -> tuple[list[int], int]:
    """The play order for a fresh queue: identity honoring `start`, or a
    shuffle anchored there."""
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
    """The stored session, or an empty one when none exists (first run)."""
    conn = request.app.state.db.connect()
    return _read_snapshot(conn)


@router.post("/api/queue", response_model=QueueSnapshot)
def play_queue(request: Request, body: QueuePlayIn) -> QueueSnapshot:
    """Play this view: replace the queue with the whole filter and start at `start`."""
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
            conn,
            track_ids=ids,
            order=play_order,
            order_pos=order_pos,
            position=0.0,
            # The caller declares what this queue IS; recorded so every
            # surface can say "Playing from …".
            origin=body.origin,
        ),
    )
    return _read_snapshot(conn)


@router.put("/api/queue", response_model=QueueSnapshot)
def put_queue(request: Request, body: QueuePutIn) -> QueueSnapshot:
    """The client's plan mirror: whole-snapshot replace with a client-built
    play order. A malformed order is a 422, never a corrupted server copy."""
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
            # The origin rides the mirror unchanged: queue edits never
            # rewrite where the queue came from.
            origin=body.origin,
        ),
    )
    return _read_snapshot(conn)


@router.patch("/api/queue", response_model=QueuePlayheadOut)
def patch_queue(request: Request, body: QueuePatchIn) -> QueuePlayheadOut:
    """The playhead update, plus a played_at stamp when a real playback
    start reports its track id — carried explicitly so an in-flight mirror
    PUT cannot mis-stamp."""
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

    # Stamp and playhead share one retry window — a scan's write transaction
    # must not thin the played_at record either.
    _write_transaction(conn, _apply)
    return QueuePlayheadOut(order_pos=order_pos, position=position, updated_at=updated_at)
