"""Media endpoints: audio streaming (nginx X-Accel-Redirect or direct FileResponse) + artwork."""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from app import config
from app import lyrics as lyrics_files
from app.artwork import (
    MIME_OCTET,
    THUMB_CACHE_DIR,
    THUMB_SIZES,
    cached_thumbnail,
    served_mime,
    snap_size,
    thumbnail_path,
)
from app.routers.common import TxRoute
from app.schemas import LyricsLine, LyricsOut

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


@router.get("/api/tracks/{track_id}/lyrics", response_model=LyricsOut)
def get_lyrics(request: Request, track_id: int) -> LyricsOut:
    """The song's lyrics from its own files: a .lrc beside it, its lyrics
    tag, or a .txt beside it. Never fetched from anywhere else."""
    conn = request.app.state.db.connect()
    track = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")
    found = lyrics_files.for_file(config.MUSIC_DIR, track["path"])
    return LyricsOut(
        synced=found.synced,
        lines=[LyricsLine(time=line.time, text=line.text) for line in found.lines],
    )


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
    # The hash first: a revalidation or a cached thumbnail needs nothing
    # else, and the original can be megabytes.
    row = conn.execute("SELECT hash FROM artwork WHERE id = ?", (artwork_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Artwork not found")
    digest = row["hash"]

    # Artwork ids are content-addressed (sha1 dedup), so the bytes for a
    # given id can never change — cache aggressively, and answer a
    # revalidation from the hash alone.
    etag = f'"{digest[:16]}-{snap_size(s) if s is not None else "o"}"'
    headers = {**_ARTWORK_HEADERS, "ETag": etag}
    if etag in request.headers.get("if-none-match", ""):
        return Response(status_code=304, headers=headers)
    cache_dir = config.DATA_DIR / THUMB_CACHE_DIR
    if s is not None:
        thumb = cached_thumbnail(cache_dir, artwork_id, digest, s)
        if thumb is not None:
            return FileResponse(thumb, media_type="image/jpeg", headers=headers)

    original = conn.execute("SELECT blob FROM artwork WHERE id = ?", (artwork_id,)).fetchone()
    if original is None:  # pruned between the two reads
        raise HTTPException(status_code=404, detail="Artwork not found")
    blob = original["blob"]
    mime = served_mime(blob)
    if s is not None and mime != MIME_OCTET:
        thumb = thumbnail_path(cache_dir, artwork_id, digest, blob, s)
        if thumb is not None:
            return FileResponse(thumb, media_type="image/jpeg", headers=headers)
    return Response(content=blob, media_type=mime, headers=headers)
