"""Media endpoints: audio streaming (nginx X-Accel-Redirect or direct FileResponse) + artwork."""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

from app import config

log = logging.getLogger("flow.media")

router = APIRouter(tags=["media"])


@router.get("/api/stream/{track_id}")
def stream_track(request: Request, track_id: int) -> Response:
    conn = request.app.state.db.connect()
    track = conn.execute(
        "SELECT path, format, media_path FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    # A repaired track streams its remuxed copy from the data dir; the
    # library path keeps pointing at the untouched original.
    file_path = (
        Path(track["media_path"]) if track["media_path"] else config.MUSIC_DIR / track["path"]
    )
    if not file_path.is_file():
        # The index is ahead of the disk (deleted/moved before a rescan; the
        # next scan re-derives it). Never stream a wrong file.
        log.warning("Stream requested for missing file: %s", file_path)
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    media_type = config.AUDIO_MIME.get(track["format"], "application/octet-stream")

    if config.STREAM_MODE == "nginx":
        base = "/repaired-internal/" if track["media_path"] else "/music-internal/"
        redirect = base + quote(file_path.name if track["media_path"] else track["path"])
        return Response(
            status_code=200,
            media_type=media_type,
            headers={"X-Accel-Redirect": redirect, "Accept-Ranges": "bytes"},
        )

    return FileResponse(file_path, media_type=media_type)


@router.get("/api/artwork/{artwork_id}")
def get_artwork(request: Request, artwork_id: int) -> Response:
    conn = request.app.state.db.connect()
    row = conn.execute(
        "SELECT blob, mime FROM artwork WHERE id = ?", (artwork_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Artwork not found")

    # Artwork ids are content-addressed (sha1 dedup), so the bytes for a
    # given id can never change — cache aggressively.
    return Response(
        content=row["blob"],
        media_type=row["mime"],
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
