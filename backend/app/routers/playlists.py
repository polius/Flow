"""Playlist CRUD, membership, and ordering (set-like add, full-replace reorder)."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request, Response, UploadFile

from app.routers.covers import store_uploaded_artwork
from app.schemas import (
    PlaylistCreate,
    PlaylistDetail,
    PlaylistListOut,
    PlaylistOrderIn,
    PlaylistSummary,
    PlaylistTrackOut,
    PlaylistTracksIn,
    PlaylistUpdate,
)
from app.routers.library import PLAYLIST_TRACK_SELECT, track_out

router = APIRouter(tags=["playlists"])

DEFAULT_LIMIT = 200
MAX_LIMIT = 1000


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clamp(limit: int, offset: int) -> tuple[int, int]:
    return min(max(limit, 1), MAX_LIMIT), max(offset, 0)


def _summary(conn, row) -> PlaylistSummary:
    artwork_ids = [
        r["artwork_id"]
        for r in conn.execute(
            "SELECT t.artwork_id FROM playlist_tracks pt "
            "JOIN tracks t ON t.id = pt.track_id "
            "WHERE pt.playlist_id = ? AND t.artwork_id IS NOT NULL "
            "ORDER BY pt.position LIMIT 4",
            (row["id"],),
        ).fetchall()
    ]
    return PlaylistSummary(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        created_at=row["created_at"],
        track_count=row["track_count"],
        duration_total=row["duration_total"],
        cover_artwork_id=row["cover_artwork_id"],
        artwork_ids=artwork_ids,
    )


def _detail(conn, playlist_id: int) -> PlaylistDetail:
    row = conn.execute(
        "SELECT p.id, p.name, p.description, p.created_at, p.cover_artwork_id, "
        "COUNT(pt.track_id) AS track_count, "
        "COALESCE(SUM(t.duration), 0) AS duration_total "
        "FROM playlists p "
        "LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id "
        "LEFT JOIN tracks t ON t.id = pt.track_id "
        "WHERE p.id = ? GROUP BY p.id",
        (playlist_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Playlist not found")

    tracks = [
        PlaylistTrackOut(**track_out(r).model_dump(), position=r["position"])
        for r in conn.execute(
            f"{PLAYLIST_TRACK_SELECT} JOIN playlist_tracks pt ON pt.track_id = t.id "
            f"WHERE pt.playlist_id = ? ORDER BY pt.position",
            (playlist_id,),
        ).fetchall()
    ]
    return PlaylistDetail(**_summary(conn, row).model_dump(), tracks=tracks)


def _require_playlist(conn, playlist_id: int) -> None:
    if conn.execute(
        "SELECT 1 FROM playlists WHERE id = ?", (playlist_id,)
    ).fetchone() is None:
        raise HTTPException(status_code=404, detail="Playlist not found")


@router.get("/api/playlists", response_model=PlaylistListOut)
def list_playlists(
    request: Request,
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    offset: int = Query(0, ge=0),
) -> PlaylistListOut:
    conn = request.app.state.db.connect()
    limit, offset = _clamp(limit, offset)

    base = (
        "FROM playlists p "
        "LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id "
        "LEFT JOIN tracks t ON t.id = pt.track_id"
    )
    total = conn.execute("SELECT COUNT(*) AS c FROM playlists").fetchone()["c"]
    rows = conn.execute(
        f"SELECT p.id, p.name, p.description, p.created_at, p.cover_artwork_id, "
        f"COUNT(pt.track_id) AS track_count, "
        f"COALESCE(SUM(t.duration), 0) AS duration_total "
        f"{base} GROUP BY p.id "
        f"ORDER BY p.name COLLATE NOCASE LIMIT ? OFFSET ?",
        (limit, offset),
    ).fetchall()
    return PlaylistListOut(
        items=[_summary(conn, r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/api/playlists", response_model=PlaylistDetail, status_code=201)
def create_playlist(request: Request, body: PlaylistCreate) -> PlaylistDetail:
    conn = request.app.state.db.connect()
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Playlist name cannot be empty")
    description = body.description.strip() if body.description else None
    cur = conn.execute(
        "INSERT INTO playlists (name, description, created_at) VALUES (?, ?, ?)",
        (name, description, _utcnow()),
    )
    conn.commit()
    return _detail(conn, int(cur.lastrowid))


@router.get("/api/playlists/{playlist_id}", response_model=PlaylistDetail)
def get_playlist(request: Request, playlist_id: int) -> PlaylistDetail:
    conn = request.app.state.db.connect()
    return _detail(conn, playlist_id)


@router.patch("/api/playlists/{playlist_id}", response_model=PlaylistDetail)
def update_playlist(
    request: Request, playlist_id: int, body: PlaylistUpdate
) -> PlaylistDetail:
    conn = request.app.state.db.connect()
    _require_playlist(conn, playlist_id)

    sets, params = [], []
    if "name" in body.model_fields_set:
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="Playlist name cannot be empty")
        sets.append("name = ?")
        params.append(name)
    if "description" in body.model_fields_set:
        sets.append("description = ?")
        params.append((body.description or "").strip() or None)
    if "cover_artwork_id" in body.model_fields_set:
        if body.cover_artwork_id is not None and conn.execute(
            "SELECT 1 FROM artwork WHERE id = ?", (body.cover_artwork_id,)
        ).fetchone() is None:
            raise HTTPException(status_code=422, detail="Unknown artwork id")
        sets.append("cover_artwork_id = ?")
        params.append(body.cover_artwork_id)
    if sets:
        params.append(playlist_id)
        conn.execute(f"UPDATE playlists SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
    return _detail(conn, playlist_id)


@router.put("/api/playlists/{playlist_id}/cover", response_model=PlaylistDetail)
def set_playlist_cover(
    request: Request, playlist_id: int, file: UploadFile
) -> PlaylistDetail:
    """Store an uploaded cover image, overriding the 2×2 track mosaic."""
    conn = request.app.state.db.connect()
    _require_playlist(conn, playlist_id)
    artwork_id = store_uploaded_artwork(conn, file)
    conn.execute(
        "UPDATE playlists SET cover_artwork_id = ? WHERE id = ?",
        (artwork_id, playlist_id),
    )
    conn.commit()
    return _detail(conn, playlist_id)


@router.delete("/api/playlists/{playlist_id}", status_code=204)
def delete_playlist(request: Request, playlist_id: int) -> Response:
    conn = request.app.state.db.connect()
    _require_playlist(conn, playlist_id)
    conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
    conn.commit()
    return Response(status_code=204)


@router.post(
    "/api/playlists/{playlist_id}/tracks",
    response_model=PlaylistDetail,
    status_code=201,
)
def add_tracks(
    request: Request, playlist_id: int, body: PlaylistTracksIn, response: Response
) -> PlaylistDetail:
    """Append tracks, skipping ones already in it; counts go in X-Tracks-Added/Skipped headers."""
    conn = request.app.state.db.connect()
    _require_playlist(conn, playlist_id)
    if not body.track_ids:
        raise HTTPException(status_code=422, detail="track_ids must not be empty")

    known = {
        r["id"]
        for r in conn.execute("SELECT id FROM tracks").fetchall()
    }
    unknown = [tid for tid in body.track_ids if tid not in known]
    if unknown:
        raise HTTPException(
            status_code=422, detail=f"Unknown track ids: {unknown[:5]}"
        )

    # Set-like membership: dedupe the request, then drop anything the
    # playlist already holds — in order, once.
    wanted = list(dict.fromkeys(body.track_ids))
    present = {
        r["track_id"]
        for r in conn.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchall()
    }
    to_add = [tid for tid in wanted if tid not in present]

    if to_add:
        next_pos = (
            conn.execute(
                "SELECT COALESCE(MAX(position), 0) AS m FROM playlist_tracks "
                "WHERE playlist_id = ?",
                (playlist_id,),
            ).fetchone()["m"]
            + 1
        )
        conn.executemany(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
            [(playlist_id, tid, next_pos + i) for i, tid in enumerate(to_add)],
        )
        conn.commit()
    response.headers["X-Tracks-Added"] = str(len(to_add))
    response.headers["X-Tracks-Skipped"] = str(len(body.track_ids) - len(to_add))
    return _detail(conn, playlist_id)


@router.delete(
    "/api/playlists/{playlist_id}/tracks/{track_id}",
    response_model=PlaylistDetail,
)
def remove_track(
    request: Request, playlist_id: int, track_id: int
) -> PlaylistDetail:
    conn = request.app.state.db.connect()
    _require_playlist(conn, playlist_id)

    existing = conn.execute(
        "SELECT COUNT(*) AS c FROM playlist_tracks "
        "WHERE playlist_id = ? AND track_id = ?",
        (playlist_id, track_id),
    ).fetchone()["c"]
    if existing:
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
            (playlist_id, track_id),
        )
        _resequence(conn, playlist_id)
        conn.commit()
    return _detail(conn, playlist_id)


@router.put("/api/playlists/{playlist_id}/order", response_model=PlaylistDetail)
def reorder_playlist(
    request: Request, playlist_id: int, body: PlaylistOrderIn
) -> PlaylistDetail:
    conn = request.app.state.db.connect()
    _require_playlist(conn, playlist_id)

    current = [
        r["track_id"]
        for r in conn.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? "
            "ORDER BY position",
            (playlist_id,),
        ).fetchall()
    ]
    if Counter(body.track_ids) != Counter(current):
        raise HTTPException(
            status_code=422,
            detail="track_ids must be a permutation of the playlist's tracks",
        )

    conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))
    conn.executemany(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
        [(playlist_id, tid, pos + 1) for pos, tid in enumerate(body.track_ids)],
    )
    conn.commit()
    return _detail(conn, playlist_id)


def _resequence(conn, playlist_id: int) -> None:
    """Compact positions back to 1..n after a removal."""
    rows = conn.execute(
        "SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
        (playlist_id,),
    ).fetchall()
    for pos, row in enumerate(rows, start=1):
        if row["position"] != pos:
            conn.execute(
                "UPDATE playlist_tracks SET position = ? "
                "WHERE playlist_id = ? AND position = ?",
                (pos, playlist_id, row["position"]),
            )
