"""Cover editing for library entities (DESIGN.md §9.2, after §13.10).

The playlist's cover contract — PUT stores an uploaded image, removal
falls back to the derived artwork — extended to albums and artists. A
user-set cover lives in the entity's `cover_artwork_id` and OVERRIDES the
scan-derived `artwork_id` (the album's own cover, the artist's
latest-album portrait) while set; DELETE clears it and the derived art
takes back over. Bytes are stored as-is in the content-addressed
`artwork` table (sha1 dedup), the same rules scan art follows, so every
surface that shows the entity reads one column pair and the override
holds everywhere at once.
"""

from __future__ import annotations

import hashlib

from fastapi import APIRouter, HTTPException, Request, UploadFile

from app.artwork import sniff_mime
from app.schemas import AlbumDetail, AlbumUpdate, ArtistDetail, ArtistUpdate
from app.routers.library import album_detail, artist_detail
router = APIRouter(tags=["covers"])

# Cover uploads: raw bytes stored as-is (sha1 dedup), same rules as scan art.
MAX_COVER_BYTES = 10 * 1024 * 1024


def store_artwork(conn, data: bytes, mime: str) -> int:
    """Content-addressed artwork storage — shared with the playlist cover
    endpoint and the scanner's extracted art (sha1 dedup)."""
    digest = hashlib.sha1(data).hexdigest()
    row = conn.execute("SELECT id FROM artwork WHERE hash = ?", (digest,)).fetchone()
    if row is not None:
        return int(row["id"])
    return int(
        conn.execute(
            "INSERT INTO artwork (hash, blob, mime) VALUES (?, ?, ?)",
            (digest, data, mime),
        ).lastrowid
    )


def store_uploaded_artwork(conn, file: UploadFile) -> int:
    """Validate one uploaded image and store it; the 4xx contract matches
    the playlist cover endpoint's exactly (empty 422, size 413, type 415)."""
    data = file.file.read(MAX_COVER_BYTES + 1)
    if not data:
        raise HTTPException(status_code=422, detail="Cover image is empty")
    if len(data) > MAX_COVER_BYTES:
        raise HTTPException(status_code=413, detail="Cover image must be 10 MB or smaller")
    mime = sniff_mime(data)
    if mime is None:
        raise HTTPException(status_code=415, detail="Only JPEG or PNG images are supported")
    return store_artwork(conn, data, mime)


def _require_album(conn, album_id: int) -> None:
    if conn.execute(
        "SELECT 1 FROM albums WHERE id = ?", (album_id,)
    ).fetchone() is None:
        raise HTTPException(status_code=404, detail="Album not found")


def _require_artist(conn, artist_id: int) -> None:
    if conn.execute(
        "SELECT 1 FROM artists WHERE id = ?", (artist_id,)
    ).fetchone() is None:
        raise HTTPException(status_code=404, detail="Artist not found")


@router.put("/api/albums/{album_id}/cover", response_model=AlbumDetail)
def set_album_cover(
    request: Request, album_id: int, file: UploadFile
) -> AlbumDetail:
    """Store an uploaded cover image and set it as the album's cover,
    overriding the scan-derived artwork while set."""
    conn = request.app.state.db.connect()
    _require_album(conn, album_id)
    artwork_id = store_uploaded_artwork(conn, file)
    conn.execute(
        "UPDATE albums SET cover_artwork_id = ? WHERE id = ?",
        (artwork_id, album_id),
    )
    conn.commit()
    return album_detail(conn, album_id)


def _apply_cover(conn, table: str, entity_id: int, artwork_id: int | None) -> None:
    """Write one `cover_artwork_id` (or clear it). A non-null id must exist
    in the artwork table — the same 422 the playlist PATCH has always
    answered an unknown id with."""
    if artwork_id is not None and conn.execute(
        "SELECT 1 FROM artwork WHERE id = ?", (artwork_id,)
    ).fetchone() is None:
        raise HTTPException(status_code=422, detail="Unknown artwork id")
    conn.execute(
        f"UPDATE {table} SET cover_artwork_id = ? WHERE id = ?",
        (artwork_id, entity_id),
    )


@router.patch("/api/albums/{album_id}", response_model=AlbumDetail)
def update_album(
    request: Request, album_id: int, body: AlbumUpdate
) -> AlbumDetail:
    """Re-point the album's cover at an existing artwork row, or clear it.
    This is cover removal's undo path: the removed upload is still in the
    content-addressed `artwork` table, so restoring it is a reference
    write, not a re-upload (2026-10-03)."""
    conn = request.app.state.db.connect()
    _require_album(conn, album_id)
    _apply_cover(conn, "albums", album_id, body.cover_artwork_id)
    conn.commit()
    return album_detail(conn, album_id)


@router.delete("/api/albums/{album_id}/cover", response_model=AlbumDetail)
def reset_album_cover(request: Request, album_id: int) -> AlbumDetail:
    """Clear the user-set cover — the scan-derived artwork takes back over."""
    conn = request.app.state.db.connect()
    _require_album(conn, album_id)
    _apply_cover(conn, "albums", album_id, None)
    conn.commit()
    return album_detail(conn, album_id)


@router.put("/api/artists/{artist_id}/cover", response_model=ArtistDetail)
def set_artist_cover(
    request: Request, artist_id: int, file: UploadFile
) -> ArtistDetail:
    """Store an uploaded image and set it as the artist's portrait,
    overriding the latest-album cover while set."""
    conn = request.app.state.db.connect()
    _require_artist(conn, artist_id)
    artwork_id = store_uploaded_artwork(conn, file)
    conn.execute(
        "UPDATE artists SET cover_artwork_id = ? WHERE id = ?",
        (artwork_id, artist_id),
    )
    conn.commit()
    return artist_detail(conn, artist_id)


@router.patch("/api/artists/{artist_id}", response_model=ArtistDetail)
def update_artist(
    request: Request, artist_id: int, body: ArtistUpdate
) -> ArtistDetail:
    """Re-point the artist's portrait at an existing artwork row, or clear
    it — cover removal's undo path, same as the album's."""
    conn = request.app.state.db.connect()
    _require_artist(conn, artist_id)
    _apply_cover(conn, "artists", artist_id, body.cover_artwork_id)
    conn.commit()
    return artist_detail(conn, artist_id)


@router.delete("/api/artists/{artist_id}/cover", response_model=ArtistDetail)
def reset_artist_cover(request: Request, artist_id: int) -> ArtistDetail:
    """Clear the user-set portrait — the derived artwork takes back over
    (latest album's cover, or the client's monogram when there is none)."""
    conn = request.app.state.db.connect()
    _require_artist(conn, artist_id)
    _apply_cover(conn, "artists", artist_id, None)
    conn.commit()
    return artist_detail(conn, artist_id)
