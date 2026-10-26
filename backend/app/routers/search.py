"""Cross-entity search: one endpoint, grouped results, each group capped."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from app.routers.common import MAX_QUERY, TxRoute, like_pattern
from app.routers.library import ARTIST_ARTWORK_SQL, TRACK_SELECT, track_out
from app.routers.playlists import playlist_summaries
from app.schemas import (
    AlbumSummary,
    ArtistSummary,
    SearchOut,
)

router = APIRouter(tags=["search"], route_class=TxRoute)

GROUP_LIMIT = 20


@router.get("/api/search", response_model=SearchOut)
def search(
    request: Request, q: str = Query(min_length=1, max_length=MAX_QUERY)
) -> SearchOut:
    conn = request.app.state.db.connect()
    term = like_pattern(q)

    # The same row shape as every other track list (genre, album artist,
    # recency and gain included).
    tracks = [
        track_out(r)
        for r in conn.execute(
            f"{TRACK_SELECT} "
            "WHERE t.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\' "
            "OR al.title LIKE ? ESCAPE '\\' "
            "ORDER BY t.title COLLATE NOCASE, t.id LIMIT ?",
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
            "GROUP BY al.id ORDER BY al.title COLLATE NOCASE, al.id LIMIT ?",
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
            f"{ARTIST_ARTWORK_SQL} AS artwork_id, "
            "(SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count, "
            "(SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id) AS track_count "
            "FROM artists ar WHERE ar.name LIKE ? ESCAPE '\\' "
            "ORDER BY ar.name COLLATE NOCASE, ar.id LIMIT ?",
            (term, GROUP_LIMIT),
        ).fetchall()
    ]

    playlists = playlist_summaries(
        conn,
        conn.execute(
            "SELECT p.id, p.name, p.description, p.cover_artwork_id, "
            "p.created_at, "
            "COUNT(pt.track_id) AS track_count, "
            "COALESCE(SUM(t.duration), 0) AS duration_total "
            "FROM playlists p "
            "LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id "
            "LEFT JOIN tracks t ON t.id = pt.track_id "
            "WHERE p.name LIKE ? ESCAPE '\\' "
            "GROUP BY p.id ORDER BY p.name COLLATE NOCASE, p.id LIMIT ?",
            (term, GROUP_LIMIT),
        ).fetchall(),
    )

    return SearchOut(
        query=q, tracks=tracks, albums=albums, artists=artists, playlists=playlists
    )
