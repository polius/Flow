"""Shared entity helpers: find-or-create artists/albums/genres, orphan pruning (one code path for scans and manual edits)."""

from __future__ import annotations

import unicodedata


def name_key(name: str) -> str:
    """The lookup key for artist names and album titles: NFC + full Unicode
    casefold. `COLLATE NOCASE` only folds ASCII, so "Beyoncé", its NFD
    spelling and "BEYONCÉ" would otherwise be three artists."""
    return unicodedata.normalize("NFC", name.strip()).casefold()


def _clean(name: str | None) -> str | None:
    if not name or not name.strip():
        return None
    return unicodedata.normalize("NFC", name.strip())


def find_or_create_artist(conn, name: str | None) -> int | None:
    """Resolve an artist name to a row id; empty names map to NULL."""
    name = _clean(name)
    if name is None:
        return None
    key = name_key(name)
    # Lowest id wins among rows sharing a key (pre-key duplicates from older
    # releases), so the choice is stable across scans.
    row = conn.execute(
        "SELECT id FROM artists WHERE name_key = ? ORDER BY id LIMIT 1", (key,)
    ).fetchone()
    if row is None:
        # A row not yet backfilled (written by an older release) still
        # matches the old way; `name` is UNIQUE NOCASE, so inserting past it
        # would fail anyway.
        row = conn.execute(
            "SELECT id, name FROM artists WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if row is not None:
            conn.execute(
                "UPDATE artists SET name_key = ? WHERE id = ? AND name_key IS NULL",
                (name_key(row["name"]), row["id"]),
            )
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO artists (name, name_key) VALUES (?, ?)", (name, key)
    )
    return int(cur.lastrowid)


def find_or_create_album(
    conn, title: str | None, artist_id: int | None, year: int | None
) -> int | None:
    """Resolve (title, album artist) to an album row, backfilling the year."""
    title = _clean(title)
    if title is None:
        return None
    key = name_key(title)
    row = conn.execute(
        "SELECT id, year FROM albums WHERE title_key = ? AND artist_id IS ? "
        "ORDER BY id LIMIT 1",
        (key, artist_id),
    ).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT id, year, title FROM albums "
            "WHERE title = ? COLLATE NOCASE AND artist_id IS ? AND title_key IS NULL "
            "ORDER BY id LIMIT 1",
            (title, artist_id),
        ).fetchone()
        if row is not None:
            conn.execute(
                "UPDATE albums SET title_key = ? WHERE id = ?",
                (name_key(row["title"]), row["id"]),
            )
    if row:
        if row["year"] is None and year is not None:
            conn.execute("UPDATE albums SET year = ? WHERE id = ?", (year, row["id"]))
        return row["id"]
    cur = conn.execute(
        "INSERT INTO albums (title, title_key, artist_id, year) VALUES (?, ?, ?, ?)",
        (title, key, artist_id, year),
    )
    return int(cur.lastrowid)


def backfill_name_keys(conn) -> int:
    """Fill name_key / title_key for rows that have none (migration 003
    can't compute NFC/casefold in SQL). Idempotent and cheap once done —
    both scans hit the key index. Returns the number of rows filled; the
    caller commits."""
    filled = 0
    for table, column, key_column in (
        ("artists", "name", "name_key"),
        ("albums", "title", "title_key"),
    ):
        rows = conn.execute(
            f"SELECT id, {column} AS name FROM {table} WHERE {key_column} IS NULL"  # noqa: S608
        ).fetchall()
        for row in rows:
            conn.execute(
                f"UPDATE {table} SET {key_column} = ? WHERE id = ?",  # noqa: S608
                (name_key(row["name"] or ""), row["id"]),
            )
        filled += len(rows)
    return filled


def find_or_create_genre(conn, name: str | None) -> int | None:
    """Resolve a genre name to a row id; empty names map to NULL."""
    name = _clean(name)
    if name is None:
        return None
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
        "  UNION SELECT artwork_id FROM albums WHERE artwork_id IS NOT NULL"
        "  UNION SELECT cover_artwork_id FROM albums WHERE cover_artwork_id IS NOT NULL"
        "  UNION SELECT cover_artwork_id FROM artists WHERE cover_artwork_id IS NOT NULL"
        "  UNION SELECT cover_artwork_id FROM playlists WHERE cover_artwork_id IS NOT NULL)"
    )
