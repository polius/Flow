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
    GenreListOut,
    GenreSummary,
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
    "added_at": "t.added_at",
    # Recently played (§4.1) — read path for the recency record; no counts.
    "played": "t.played_at",
    # Organize view (§22): the file column sorts by its library-relative path.
    "path": "t.path COLLATE NOCASE",
    # Organize view (§22): the track's primary genre (first tag genre).
    "genre": (
        "(SELECT g2.name FROM track_genres tg2 "
        "JOIN genres g2 ON g2.id = tg2.genre_id "
        "WHERE tg2.track_id = t.id ORDER BY tg2.genre_id LIMIT 1) COLLATE NOCASE"
    ),
    # Favorites' manual order (2026-10-03): the drag-written curation order.
    # Unplaced favorites (loved before the order existed) trail the placed
    # ones deterministically by title (the endpoint's tie-breaker).
    "favorite": "(t.favorite_position IS NULL), t.favorite_position",
}

# Direction is applied per term by the endpoint (`dir` query param) so the
# whitelisted expressions above stay direction-neutral.

ARTIST_SORTS = {
    "name": "ar.name COLLATE NOCASE",
    # Count sorts read most-first by default (the client sends dir=desc).
    "albums": "album_count",
    "songs": "track_count",
}

# The artist's portrait: their latest album's cover (NULL year last).
ARTIST_ARTWORK_SQL = (
    "(SELECT al2.artwork_id FROM albums al2 WHERE al2.artist_id = ar.id "
    "AND al2.artwork_id IS NOT NULL ORDER BY (al2.year IS NULL), al2.year DESC LIMIT 1) "
)

ALBUM_SORTS = {
    "title": "al.title COLLATE NOCASE",
    "artist": "(ar.name IS NULL), ar.name COLLATE NOCASE",
    "year": "al.year",
    "recent": "MAX(t.added_at)",
    # Recently played (§4.1): the album's most recent real playback start.
    # NULLs sort first ascending / last descending, so never-played albums
    # sit at the honest end of either direction.
    "played": "MAX(t.played_at)",
}

# Every genre that still has at least one track — an emptied genre is
# pruned by the scanner anyway, so this is only defensive.
GENRE_BASE = """
FROM genres g
JOIN track_genres tg ON tg.genre_id = g.id
JOIN tracks t ON t.id = tg.track_id
"""


def _like(term: str) -> str:
    """Escape LIKE wildcards in user input."""
    return f"%{term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')}%"


def _directed(order_sql: str, desc: bool) -> str:
    """Apply one direction to every term of a whitelisted ORDER BY expression.
    Sort expressions stay direction-neutral above; DESC here means a full
    reverse of the chosen ordering (nulls-first clauses flip with it, which
    reads as the honest inverse of the ascending view)."""
    terms = [t.strip() for t in order_sql.split(",")]
    return ", ".join(f"{t} DESC" for t in terms) if desc else ", ".join(terms)


def _clamp(limit: int, offset: int) -> tuple[int, int]:
    return min(max(limit, 1), MAX_LIMIT), max(offset, 0)


TRACK_SELECT = """
SELECT t.id, t.title, t.track_no, t.disc_no, t.year, t.duration, t.format,
       t.favorite, t.album_id, t.artist_id, t.artwork_id, t.path, t.gain_db,
       t.played_at, t.added_at,
       ar.name AS artist, al.title AS album,
       t.album_artist_id, aar2.name AS album_artist,
       (SELECT g.name FROM track_genres tg
        JOIN genres g ON g.id = tg.genre_id
        WHERE tg.track_id = t.id ORDER BY tg.genre_id LIMIT 1) AS genre
FROM tracks t
LEFT JOIN artists ar ON ar.id = t.artist_id
LEFT JOIN albums al ON al.id = t.album_id
LEFT JOIN artists aar ON aar.id = al.artist_id
LEFT JOIN artists aar2 ON aar2.id = t.album_artist_id
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
    favorite: bool | None = None,
    genre_id: int | None = None,
) -> tuple[str, list]:
    """Shared WHERE builder for GET /api/tracks and the bulk apply (§22):
    a filter-based selection must resolve to exactly what the grid showed.
    Raises 422 on an unknown review value. `artist_id` matches credited
    tracks too (§2.2) — the filter means "this artist's music", not
    "rows whose primary column says so".
    """
    where, params = [], []
    if q:
        where.append(
            "(t.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\' "
            "OR al.title LIKE ? ESCAPE '\\')"
        )
        params += [_like(q), _like(q), _like(q)]
    if artist_id is not None:
        where.append(
            "(t.artist_id = ? OR t.id IN "
            "(SELECT track_id FROM track_artists WHERE artist_id = ?))"
        )
        params += [artist_id, artist_id]
    if album_id is not None:
        where.append("t.album_id = ?")
        params.append(album_id)
    if review is not None:
        clause = REVIEW_FILTERS.get(review)
        if clause is None:
            raise HTTPException(status_code=422, detail="Unknown review filter")
        where.append(clause)
    if favorite is not None:
        where.append("t.favorite = ?")
        params.append(1 if favorite else 0)
    if genre_id is not None:
        where.append(
            "t.id IN (SELECT track_id FROM track_genres WHERE genre_id = ?)"
        )
        params.append(genre_id)
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
        album_artist=row["album_artist"],
        track_no=row["track_no"],
        disc_no=row["disc_no"],
        year=row["year"],
        duration=row["duration"],
        format=row["format"],
        favorite=bool(row["favorite"]),
        artwork_id=row["artwork_id"],
        path=row["path"],
        gain_db=row["gain_db"],
        played_at=row["played_at"],
        genre=row["genre"],
        added_at=row["added_at"],
    )


@router.get("/api/tracks", response_model=TrackListOut)
def list_tracks(
    request: Request,
    q: str | None = None,
    artist_id: int | None = None,
    album_id: int | None = None,
    review: str | None = None,
    favorite: bool | None = None,
    genre_id: int | None = None,
    sort: str = "title",
    dir: str = "asc",
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    offset: int = Query(0, ge=0),
) -> TrackListOut:
    conn = request.app.state.db.connect()
    limit, offset = _clamp(limit, offset)

    clause, params = track_filter_where(
        q=q,
        artist_id=artist_id,
        album_id=album_id,
        review=review,
        favorite=favorite,
        genre_id=genre_id,
    )

    desc = dir == "desc"
    order = TRACK_SORTS.get(sort, TRACK_SORTS["title"])

    total = conn.execute(
        f"SELECT COUNT(*) AS c FROM tracks t "
        f"LEFT JOIN artists ar ON ar.id = t.artist_id "
        f"LEFT JOIN albums al ON al.id = t.album_id {clause}",
        params,
    ).fetchone()["c"]
    rows = conn.execute(
        f"{TRACK_SELECT} {clause} ORDER BY {_directed(order, desc)}, "
        f"t.title COLLATE NOCASE {'DESC' if desc else ''} LIMIT ? OFFSET ?",
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
    dir: str = "asc",
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
    directed = _directed(order, dir == "desc")

    total = conn.execute(
        f"SELECT COUNT(DISTINCT al.id) AS c {base} {clause}", params
    ).fetchone()["c"]
    rows = conn.execute(
        f"SELECT al.id, al.title, al.year, al.artwork_id, al.cover_artwork_id, "
        f"ar.name AS artist, al.artist_id, COUNT(t.id) AS track_count, "
        f"MAX(t.played_at) AS played_at "
        f"{base} {clause} GROUP BY al.id ORDER BY {directed}, al.title COLLATE NOCASE "
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
                cover_artwork_id=r["cover_artwork_id"],
                track_count=r["track_count"],
                played_at=r["played_at"],
            )
            for r in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


def album_detail(conn, album_id: int) -> AlbumDetail:
    """The album detail payload — shared by the read endpoint and the
    cover router (a cover PUT/DELETE echoes the refreshed detail)."""
    album = conn.execute(
        "SELECT al.id, al.title, al.year, al.artwork_id, al.cover_artwork_id, "
        "ar.name AS artist, al.artist_id FROM albums al "
        "LEFT JOIN artists ar ON ar.id = al.artist_id "
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
        cover_artwork_id=album["cover_artwork_id"],
        track_count=len(tracks),
        duration_total=sum(t.duration for t in tracks),
        played_at=max((t.played_at for t in tracks if t.played_at), default=None),
        tracks=tracks,
    )


@router.get("/api/albums/{album_id}", response_model=AlbumDetail)
def get_album(request: Request, album_id: int) -> AlbumDetail:
    conn = request.app.state.db.connect()
    return album_detail(conn, album_id)


@router.get("/api/artists", response_model=ArtistListOut)
def list_artists(
    request: Request,
    q: str | None = None,
    sort: str = "name",
    dir: str = "asc",
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
    order = ARTIST_SORTS.get(sort, ARTIST_SORTS["name"])
    directed = _directed(order, dir == "desc")
    # track_count covers every credited appearance (§2.2): a featured
    # artist with no lead credits is still browsable, with an honest count.
    credited_count = (
        "(SELECT COUNT(*) FROM ("
        "  SELECT t.id FROM tracks t WHERE t.artist_id = ar.id"
        "  UNION"
        "  SELECT ta.track_id FROM track_artists ta WHERE ta.artist_id = ar.id))"
    )
    rows = conn.execute(
        f"SELECT ar.id, ar.name, ar.cover_artwork_id, "
        f"{ARTIST_ARTWORK_SQL} AS artwork_id, "
        f"(SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count, "
        f"{credited_count} AS track_count "
        f"FROM artists ar {clause} "
        f"ORDER BY {directed}, ar.name COLLATE NOCASE LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return ArtistListOut(
        items=[
            ArtistSummary(
                id=r["id"],
                name=r["name"],
                album_count=r["album_count"],
                track_count=r["track_count"],
                artwork_id=r["artwork_id"],
                cover_artwork_id=r["cover_artwork_id"],
            )
            for r in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


def artist_detail(conn, artist_id: int) -> ArtistDetail:
    """The artist detail payload — shared by the read endpoint and the
    cover router (a cover PUT/DELETE echoes the refreshed detail)."""
    artist = conn.execute(
        f"SELECT ar.id, ar.name, ar.cover_artwork_id, "
        f"{ARTIST_ARTWORK_SQL} AS artwork_id "
        f"FROM artists ar WHERE ar.id = ?",
        (artist_id,),
    ).fetchone()
    if artist is None:
        raise HTTPException(status_code=404, detail="Artist not found")

    album_rows = conn.execute(
        "SELECT al.id, al.title, al.year, al.artwork_id, al.cover_artwork_id, "
        "ar.name AS artist, al.artist_id, COUNT(t.id) AS track_count "
        "FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id "
        "LEFT JOIN tracks t ON t.album_id = al.id "
        "WHERE al.artist_id = ? GROUP BY al.id "
        "ORDER BY al.year, al.title COLLATE NOCASE",
        (artist_id,),
    ).fetchall()
    # The artist's songs: lead credits, plus every credited appearance
    # (featured / composer / additional main) from the join table (§2.2).
    track_rows = conn.execute(
        f"{TRACK_SELECT} WHERE t.artist_id = ? "
        f"OR t.id IN (SELECT track_id FROM track_artists WHERE artist_id = ?) "
        f"ORDER BY t.year, t.disc_no, t.track_no, t.title COLLATE NOCASE",
        (artist_id, artist_id),
    ).fetchall()

    albums = [
        AlbumSummary(
            id=r["id"],
            title=r["title"],
            artist=r["artist"],
            artist_id=r["artist_id"],
            year=r["year"],
            artwork_id=r["artwork_id"],
            cover_artwork_id=r["cover_artwork_id"],
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
        artwork_id=artist["artwork_id"],
        cover_artwork_id=artist["cover_artwork_id"],
        albums=albums,
        tracks=tracks,
    )


@router.get("/api/artists/{artist_id}", response_model=ArtistDetail)
def get_artist(request: Request, artist_id: int) -> ArtistDetail:
    conn = request.app.state.db.connect()
    return artist_detail(conn, artist_id)


@router.get("/api/genres", response_model=GenreListOut)
def list_genres(
    request: Request,
    q: str | None = None,
    sort: str = "name",
    dir: str = "asc",
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    offset: int = Query(0, ge=0),
) -> GenreListOut:
    """Genre browse list (§2.2): the track's tags, grouped. A representative
    cover keeps the grid art-first; counts are honest (distinct tracks)."""
    conn = request.app.state.db.connect()
    limit, offset = _clamp(limit, offset)

    where, params = ["1 = 1"], []
    if q:
        where.append("g.name LIKE ? ESCAPE '\\'")
        params.append(_like(q))
    clause = f"WHERE {' AND '.join(where)}"

    total = conn.execute(
        f"SELECT COUNT(DISTINCT g.id) AS c {GENRE_BASE} {clause}", params
    ).fetchone()["c"]

    GENRE_SORTS = {
        "name": "g.name COLLATE NOCASE",
        "songs": "COUNT(DISTINCT tg.track_id)",
        "recent": "MAX(t.added_at)",
    }
    order = GENRE_SORTS.get(sort, GENRE_SORTS["name"])
    directed = _directed(order, dir == "desc")

    rows = conn.execute(
        f"SELECT g.id, g.name, COUNT(DISTINCT tg.track_id) AS track_count, "
        f"COUNT(DISTINCT t.album_id) AS album_count, "
        f"(SELECT t2.artwork_id FROM track_genres tg2 "
        f"  JOIN tracks t2 ON t2.id = tg2.track_id "
        f"  WHERE tg2.genre_id = g.id AND t2.artwork_id IS NOT NULL "
        f"  ORDER BY t2.added_at DESC LIMIT 1) AS artwork_id "
        f"{GENRE_BASE} {clause} "
        f"GROUP BY g.id ORDER BY {directed}, g.name COLLATE NOCASE "
        f"LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return GenreListOut(
        items=[
            GenreSummary(
                id=r["id"],
                name=r["name"],
                track_count=r["track_count"],
                album_count=r["album_count"],
                artwork_id=r["artwork_id"],
            )
            for r in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
