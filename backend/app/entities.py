"""Shared entity helpers: find-or-create artists/albums, orphan pruning.

One implementation serves both callers that regroup tracks — the scanner's
upsert path (DESIGN.md §5) and the Get Info editor (§13.2) — so grouping
semantics can never diverge between a scan and a manual edit.
"""

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


def prune_orphans(conn) -> None:
    """Derived entities (§13.2): rows with no referencing track are removed."""
    conn.execute(
        "DELETE FROM albums WHERE id NOT IN "
        "(SELECT album_id FROM tracks WHERE album_id IS NOT NULL)"
    )
    conn.execute(
        "DELETE FROM artists WHERE id NOT IN ("
        "  SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL"
        "  UNION SELECT album_artist_id FROM tracks WHERE album_artist_id IS NOT NULL"
        "  UNION SELECT artist_id FROM albums WHERE artist_id IS NOT NULL)"
    )
    conn.execute(
        "DELETE FROM artwork WHERE id NOT IN ("
        "  SELECT artwork_id FROM tracks WHERE artwork_id IS NOT NULL"
        "  UNION SELECT artwork_id FROM albums WHERE artwork_id IS NOT NULL)"
    )
