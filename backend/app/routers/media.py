"""Media endpoints: audio streaming (nginx X-Accel-Redirect or direct FileResponse) + artwork."""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from app import config
from app.artwork import MIME_OCTET, THUMB_CACHE_DIR, THUMB_SIZES, served_mime, thumbnail_path
from app.routers.common import TxRoute

log = logging.getLogger("flow.media")

router = APIRouter(tags=["media"], route_class=TxRoute)


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


# Artwork is served from the app's own origin, so a blob must never be able
# to act as a document: the type comes from sniffing the bytes (never the
# stored column, which older versions filled from tag claims), nosniff stops
# the browser second-guessing it, and the sandbox CSP neuters anything that
# still renders. `private`: covers sit behind the login gate, so a shared
# cache in front of Flow must not hand them to anonymous users.
_ARTWORK_HEADERS = {
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


@router.get("/api/artwork/{artwork_id}")
def get_artwork(
    request: Request,
    artwork_id: int,
    s: int | None = Query(
        None,
        ge=1,
        description="Edge length in px for a resized JPEG "
        f"({', '.join(map(str, THUMB_SIZES))}; other values snap up). "
        "Absent = the original bytes.",
    ),
) -> Response:
    conn = request.app.state.db.connect()
    row = conn.execute(
        "SELECT blob, hash FROM artwork WHERE id = ?", (artwork_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Artwork not found")

    # Artwork ids are content-addressed (sha1 dedup), so the bytes for a
    # given id can never change — cache aggressively.
    mime = served_mime(row["blob"])
    if s is not None and mime != MIME_OCTET:
        thumb = thumbnail_path(
            config.DATA_DIR / THUMB_CACHE_DIR, artwork_id, row["hash"], row["blob"], s
        )
        if thumb is not None:
            return FileResponse(thumb, media_type="image/jpeg", headers=_ARTWORK_HEADERS)
    return Response(content=row["blob"], media_type=mime, headers=_ARTWORK_HEADERS)
