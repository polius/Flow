"""Library read endpoints: tracks, albums, artists (DESIGN.md §6).

All list endpoints share the same contract: `limit`/`offset` pagination with
a `total`, optional `q` filtering, and whitelisted `sort` values. Built for
large libraries from day one; frontend virtualization lands in Milestone 6.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.schemas import (
    AlbumDetail,
    AlbumListOut,
    AlbumSummary,
    ArtistDetail,
    ArtistListOut,
    ArtistSummary,
    TrackListOut,
    TrackOut,
)

router = APIRouter(tags=["library"])

DEFAULT_LIMIT = 200
MAX_LIMIT = 1000

TRACK_SORTS = {
    "title": "t.title COLLATE NOCASE",
    "artist": "(ar.name IS NULL), ar.name COLLATE NOCASE",
    "album": "(al.title IS NULL), al.title COLLATE NOCASE",
    # Organize view (§22): album blocks contiguous (same title, artist-ordered),
    # track order within, loose tracks last — the ordering curation thinks in.
    "curate": "(al.title IS NULL), al.title COLLATE NOCASE, aar.name COLLATE NOCASE, "
    "t.disc_no, t.track_no, t.title COLLATE NOCASE",
    "track_no": "t.disc_no, t.track_no",
    "year": "t.year",
    "duration": "t.duration",
    "added_at": "t.added_at DESC",
}

ALBUM_SORTS = {
    "title": "al.title COLLATE NOCASE",
    "artist": "(ar.name IS NULL), ar.name COLLATE NOCASE",
    "year": "al.year",
    "recent": "MAX(t.added_at) DESC",
}


def _like(term: str) -> str:
    """Escape LIKE wildcards in user input."""
    return f"%{term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')}%"


def _clamp(limit: int, offset: int) -> tuple[int, int]:
    return min(max(limit, 1), MAX_LIMIT), max(offset, 0)


TRACK_SELECT = """
SELECT t.id, t.title, t.track_no, t.disc_no, t.year, t.duration, t.format,
       t.favorite, t.album_id, t.artist_id, t.artwork_id,
       ar.name AS artist, al.title AS album
FROM tracks t
LEFT JOIN artists ar ON ar.id = t.artist_id
LEFT JOIN albums al ON al.id = t.album_id
LEFT JOIN artists aar ON aar.id = al.artist_id
"""

# Curation predicates for the Organize view (§22) — album-level problems
# expressed over track rows so the grid and the bulk apply select honestly.
REVIEW_FILTERS = {
    "no_album": "t.album_id IS NULL",
    "missing_track_no": "t.track_no IS NULL",
    "single_track_albums": (
        "t.album_id IN (SELECT album_id FROM tracks WHERE album_id IS NOT NULL "
        "GROUP BY album_id HAVING COUNT(*) = 1)"
    ),
    "mixed_album_artist": (
        "t.album_id IN (SELECT album_id FROM tracks WHERE album_id IS NOT NULL "
        "GROUP BY album_id HAVING COUNT(DISTINCT COALESCE(album_artist_id, -1)) > 1)"
    ),
}


def track_filter_where(
    *,
    q: str | None = None,
    artist_id: int | None = None,
    album_id: int | None = None,
    review: str | None = None,
) -> tuple[str, list]:
    """Shared WHERE builder for GET /api/tracks and the bulk apply (§22):
    a filter-based selection must resolve to exactly what the grid showed.
    Raises 422 on an unknown review value."""
    where, params = [], []
    if q:
        where.append(
            "(t.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\' "
            "OR al.title LIKE ? ESCAPE '\\')"
        )
        params += [_like(q), _like(q), _like(q)]
    if artist_id is not None:
        where.append("t.artist_id = ?")
        params.append(artist_id)
    if album_id is not None:
        where.append("t.album_id = ?")
        params.append(album_id)
    if review is not None:
        clause = REVIEW_FILTERS.get(review)
        if clause is None:
            raise HTTPException(status_code=422, detail="Unknown review filter")
        where.append(clause)
    return (f"WHERE {' AND '.join(where)}" if where else ""), params

# Same shape with the playlist position prepended (playlists router).
PLAYLIST_TRACK_SELECT = TRACK_SELECT.replace(
    "SELECT", "SELECT pt.position AS position,", 1
)


def track_out(row) -> TrackOut:
    return TrackOut(
        id=row["id"],
        title=row["title"],
        artist=row["artist"],
        artist_id=row["artist_id"],
        album=row["album"],
        album_id=row["album_id"],
        track_no=row["track_no"],
        disc_no=row["disc_no"],
        year=row["year"],
        duration=row["duration"],
        format=row["format"],
        favorite=bool(row["favorite"]),
        artwork_id=row["artwork_id"],
    )


@router.get("/api/tracks", response_model=TrackListOut)
def list_tracks(
    request: Request,
    q: str | None = None,
    artist_id: int | None = None,
    album_id: int | None = None,
    review: str | None = None,
    sort: str = "title",
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    offset: int = Query(0, ge=0),
) -> TrackListOut:
    conn = request.app.state.db.connect()
    limit, offset = _clamp(limit, offset)

    clause, params = track_filter_where(
        q=q, artist_id=artist_id, album_id=album_id, review=review
    )

    order = TRACK_SORTS.get(sort, TRACK_SORTS["title"])

    total = conn.execute(
        f"SELECT COUNT(*) AS c FROM tracks t "
        f"LEFT JOIN artists ar ON ar.id = t.artist_id "
        f"LEFT JOIN albums al ON al.id = t.album_id {clause}",
        params,
    ).fetchone()["c"]
    rows = conn.execute(
        f"{TRACK_SELECT} {clause} ORDER BY {order}, t.title COLLATE NOCASE "
        f"LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return TrackListOut(
        items=[track_out(r) for r in rows], total=total, limit=limit, offset=offset
    )


@router.get("/api/tracks/{track_id}", response_model=TrackOut)
def get_track(request: Request, track_id: int) -> TrackOut:
    conn = request.app.state.db.connect()
    row = conn.execute(f"{TRACK_SELECT} WHERE t.id = ?", (track_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Track not found")
    return track_out(row)


@router.get("/api/albums", response_model=AlbumListOut)
def list_albums(
    request: Request,
    q: str | None = None,
    sort: str = "title",
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    offset: int = Query(0, ge=0),
) -> AlbumListOut:
    conn = request.app.state.db.connect()
    limit, offset = _clamp(limit, offset)

    where, params = [], []
    if q:
        where.append(
            "(al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\')"
        )
        params += [_like(q), _like(q)]
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    base = (
        "FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id "
        "LEFT JOIN tracks t ON t.album_id = al.id"
    )
    order = ALBUM_SORTS.get(sort, ALBUM_SORTS["title"])

    total = conn.execute(
        f"SELECT COUNT(DISTINCT al.id) AS c {base} {clause}", params
    ).fetchone()["c"]
    rows = conn.execute(
        f"SELECT al.id, al.title, al.year, al.artwork_id, ar.name AS artist, "
        f"al.artist_id, COUNT(t.id) AS track_count "
        f"{base} {clause} GROUP BY al.id ORDER BY {order}, al.title COLLATE NOCASE "
        f"LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return AlbumListOut(
        items=[
            AlbumSummary(
                id=r["id"],
                title=r["title"],
                artist=r["artist"],
                artist_id=r["artist_id"],
                year=r["year"],
                artwork_id=r["artwork_id"],
                track_count=r["track_count"],
            )
            for r in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/api/albums/{album_id}", response_model=AlbumDetail)
def get_album(request: Request, album_id: int) -> AlbumDetail:
    conn = request.app.state.db.connect()
    album = conn.execute(
        "SELECT al.id, al.title, al.year, al.artwork_id, ar.name AS artist, "
        "al.artist_id FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id "
        "WHERE al.id = ?",
        (album_id,),
    ).fetchone()
    if album is None:
        raise HTTPException(status_code=404, detail="Album not found")

    rows = conn.execute(
        f"{TRACK_SELECT} WHERE t.album_id = ? "
        f"ORDER BY t.disc_no, t.track_no, t.title COLLATE NOCASE",
        (album_id,),
    ).fetchall()
    tracks = [track_out(r) for r in rows]
    return AlbumDetail(
        id=album["id"],
        title=album["title"],
        artist=album["artist"],
        artist_id=album["artist_id"],
        year=album["year"],
        artwork_id=album["artwork_id"],
        track_count=len(tracks),
        duration_total=sum(t.duration for t in tracks),
        tracks=tracks,
    )


@router.get("/api/artists", response_model=ArtistListOut)
def list_artists(
    request: Request,
    q: str | None = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    offset: int = Query(0, ge=0),
) -> ArtistListOut:
    conn = request.app.state.db.connect()
    limit, offset = _clamp(limit, offset)

    where, params = [], []
    if q:
        where.append("ar.name LIKE ? ESCAPE '\\'")
        params.append(_like(q))
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = conn.execute(
        f"SELECT COUNT(*) AS c FROM artists ar {clause}", params
    ).fetchone()["c"]
    rows = conn.execute(
        f"SELECT ar.id, ar.name, "
        f"(SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count, "
        f"(SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id) AS track_count "
        f"FROM artists ar {clause} "
        f"ORDER BY ar.name COLLATE NOCASE LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return ArtistListOut(
        items=[
            ArtistSummary(
                id=r["id"],
                name=r["name"],
                album_count=r["album_count"],
                track_count=r["track_count"],
            )
            for r in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/api/artists/{artist_id}", response_model=ArtistDetail)
def get_artist(request: Request, artist_id: int) -> ArtistDetail:
    conn = request.app.state.db.connect()
    artist = conn.execute(
        "SELECT id, name FROM artists WHERE id = ?", (artist_id,)
    ).fetchone()
    if artist is None:
        raise HTTPException(status_code=404, detail="Artist not found")

    album_rows = conn.execute(
        "SELECT al.id, al.title, al.year, al.artwork_id, ar.name AS artist, "
        "al.artist_id, COUNT(t.id) AS track_count "
        "FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id "
        "LEFT JOIN tracks t ON t.album_id = al.id "
        "WHERE al.artist_id = ? GROUP BY al.id "
        "ORDER BY al.year, al.title COLLATE NOCASE",
        (artist_id,),
    ).fetchall()
    track_rows = conn.execute(
        f"{TRACK_SELECT} WHERE t.artist_id = ? "
        f"ORDER BY t.year, t.disc_no, t.track_no, t.title COLLATE NOCASE",
        (artist_id,),
    ).fetchall()

    albums = [
        AlbumSummary(
            id=r["id"],
            title=r["title"],
            artist=r["artist"],
            artist_id=r["artist_id"],
            year=r["year"],
            artwork_id=r["artwork_id"],
            track_count=r["track_count"],
        )
        for r in album_rows
    ]
    tracks = [track_out(r) for r in track_rows]
    return ArtistDetail(
        id=artist["id"],
        name=artist["name"],
        album_count=len(albums),
        track_count=len(tracks),
        albums=albums,
        tracks=tracks,
    )
