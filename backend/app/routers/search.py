"""Cross-entity search: one endpoint, grouped results, each group capped."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from app.schemas import (
    AlbumSummary,
    ArtistSummary,
    PlaylistSummary,
    SearchOut,
    TrackOut,
)

router = APIRouter(tags=["search"])

GROUP_LIMIT = 20


def _like(term: str) -> str:
    """Escape LIKE wildcards in user input."""
    return f"%{term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')}%"


@router.get("/api/search", response_model=SearchOut)
def search(request: Request, q: str = Query(min_length=1)) -> SearchOut:
    conn = request.app.state.db.connect()
    term = _like(q)

    tracks = [
        TrackOut(
            id=r["id"],
            title=r["title"],
            artist=r["artist"],
            artist_id=r["artist_id"],
            album=r["album"],
            album_id=r["album_id"],
            track_no=r["track_no"],
            disc_no=r["disc_no"],
            year=r["year"],
            duration=r["duration"],
            format=r["format"],
            favorite=bool(r["favorite"]),
            artwork_id=r["artwork_id"],
            path=r["path"],
        )
        for r in conn.execute(
            "SELECT t.id, t.title, t.track_no, t.disc_no, t.year, t.duration, "
            "t.format, t.favorite, t.album_id, t.artist_id, t.artwork_id, t.path, "
            "ar.name AS artist, al.title AS album "
            "FROM tracks t "
            "LEFT JOIN artists ar ON ar.id = t.artist_id "
            "LEFT JOIN albums al ON al.id = t.album_id "
            "WHERE t.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\' "
            "OR al.title LIKE ? ESCAPE '\\' "
            "ORDER BY t.title COLLATE NOCASE LIMIT ?",
            (term, term, term, GROUP_LIMIT),
        ).fetchall()
    ]

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
        for r in conn.execute(
            "SELECT al.id, al.title, al.year, al.artwork_id, al.cover_artwork_id, "
            "ar.name AS artist, al.artist_id, COUNT(t.id) AS track_count "
            "FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id "
            "LEFT JOIN tracks t ON t.album_id = al.id "
            "WHERE al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\' "
            "GROUP BY al.id ORDER BY al.title COLLATE NOCASE LIMIT ?",
            (term, term, GROUP_LIMIT),
        ).fetchall()
    ]

    artists = [
        ArtistSummary(
            id=r["id"], name=r["name"],
            album_count=r["album_count"], track_count=r["track_count"],
            artwork_id=r["artwork_id"],
            cover_artwork_id=r["cover_artwork_id"],
        )
        for r in conn.execute(
            "SELECT ar.id, ar.name, ar.cover_artwork_id, "
            "(SELECT al2.artwork_id FROM albums al2 WHERE al2.artist_id = ar.id "
            "AND al2.artwork_id IS NOT NULL "
            "ORDER BY (al2.year IS NULL), al2.year DESC LIMIT 1) AS artwork_id, "
            "(SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count, "
            "(SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id) AS track_count "
            "FROM artists ar WHERE ar.name LIKE ? ESCAPE '\\' "
            "ORDER BY ar.name COLLATE NOCASE LIMIT ?",
            (term, GROUP_LIMIT),
        ).fetchall()
    ]

    playlists = [
        PlaylistSummary(
            id=r["id"],
            name=r["name"],
            description=r["description"],
            created_at=r["created_at"],
            track_count=r["track_count"],
            duration_total=r["duration_total"],
            cover_artwork_id=r["cover_artwork_id"],
            artwork_ids=[],
        )
        for r in conn.execute(
            "SELECT p.id, p.name, p.description, p.cover_artwork_id, "
            "p.created_at, "
            "COUNT(pt.track_id) AS track_count, "
            "COALESCE(SUM(t.duration), 0) AS duration_total "
            "FROM playlists p "
            "LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id "
            "LEFT JOIN tracks t ON t.id = pt.track_id "
            "WHERE p.name LIKE ? ESCAPE '\\' "
            "GROUP BY p.id ORDER BY p.name COLLATE NOCASE LIMIT ?",
            (term, GROUP_LIMIT),
        ).fetchall()
    ]

    return SearchOut(
        query=q, tracks=tracks, albums=albums, artists=artists, playlists=playlists
    )
