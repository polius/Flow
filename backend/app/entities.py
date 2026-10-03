"""Shared entity helpers: find-or-create artists/albums/genres, orphan pruning (one code path for scans and manual edits)."""

from __future__ import annotations


def find_or_create_artist(conn, name: str | None) -> int | None:
    """Resolve an artist name to a row id; empty names map to NULL."""
    if not name or not name.strip():
        return None
    name = name.strip()
    row = conn.execute(
        "SELECT id FROM artists WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO artists (name) VALUES (?)", (name,))
    return int(cur.lastrowid)


def find_or_create_album(
    conn, title: str | None, artist_id: int | None, year: int | None
) -> int | None:
    """Resolve (title, album artist) to an album row, backfilling the year."""
    if not title or not title.strip():
        return None
    title = title.strip()
    row = conn.execute(
        "SELECT id, year FROM albums "
        "WHERE title = ? COLLATE NOCASE AND artist_id IS ?",
        (title, artist_id),
    ).fetchone()
    if row:
        if row["year"] is None and year is not None:
            conn.execute("UPDATE albums SET year = ? WHERE id = ?", (year, row["id"]))
        return row["id"]
    cur = conn.execute(
        "INSERT INTO albums (title, artist_id, year) VALUES (?, ?, ?)",
        (title, artist_id, year),
    )
    return int(cur.lastrowid)


def find_or_create_genre(conn, name: str | None) -> int | None:
    """Resolve a genre name to a row id; empty names map to NULL."""
    if not name or not name.strip():
        return None
    name = name.strip()
    row = conn.execute(
        "SELECT id FROM genres WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO genres (name) VALUES (?)", (name,))
    return int(cur.lastrowid)


def set_track_credits(
    conn,
    track_id: int,
    *,
    primary_artist_id: int | None,
    main: list[str],
    featured: list[str],
    composers: list[str],
) -> None:
    """Rebuild one track's credit rows from parsed tags.

    The primary display artist follows `tracks.artist_id` (the caller passes
    the post-overlay value); remaining main credits and featured/composer
    roles always follow the tags, so rescans refresh them.
    """
    conn.execute("DELETE FROM track_artists WHERE track_id = ?", (track_id,))
    position = 0
    if primary_artist_id is not None:
        conn.execute(
            "INSERT INTO track_artists (track_id, artist_id, role, position) "
            "VALUES (?, ?, 'main', 0)",
            (track_id, primary_artist_id),
        )
        position = 1
    for role, names in (("main", main), ("featured", featured), ("composer", composers)):
        for name in names:
            artist_id = find_or_create_artist(conn, name)
            if artist_id is None or artist_id == primary_artist_id:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO track_artists "
                "(track_id, artist_id, role, position) VALUES (?, ?, ?, ?)",
                (track_id, artist_id, role, position),
            )
            position += 1


def set_track_genres(conn, track_id: int, names: list[str]) -> None:
    """Rebuild one track's genre rows from parsed tags."""
    conn.execute("DELETE FROM track_genres WHERE track_id = ?", (track_id,))
    for name in names:
        genre_id = find_or_create_genre(conn, name)
        if genre_id is not None:
            conn.execute(
                "INSERT OR IGNORE INTO track_genres (track_id, genre_id) "
                "VALUES (?, ?)",
                (track_id, genre_id),
            )


def prune_orphans(conn) -> None:
    """Delete derived entity rows (albums, artists, genres, artwork) no longer referenced."""
    conn.execute(
        "DELETE FROM albums WHERE id NOT IN "
        "(SELECT album_id FROM tracks WHERE album_id IS NOT NULL)"
    )
    conn.execute(
        "DELETE FROM artists WHERE id NOT IN ("
        "  SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL"
        "  UNION SELECT album_artist_id FROM tracks WHERE album_artist_id IS NOT NULL"
        "  UNION SELECT artist_id FROM albums WHERE artist_id IS NOT NULL"
        "  UNION SELECT artist_id FROM track_artists)"
    )
    conn.execute(
        "DELETE FROM genres WHERE id NOT IN "
        "(SELECT genre_id FROM track_genres)"
    )
    conn.execute(
        "DELETE FROM artwork WHERE id NOT IN ("
        "  SELECT artwork_id FROM tracks WHERE artwork_id IS NOT NULL"
        "  UNION SELECT artwork_id FROM albums WHERE artwork_id IS NOT NULL)"
    )
