"""Shared track-edit application: one code path for PATCH /api/tracks/{id} and the Organize bulk apply + undo."""

from __future__ import annotations

import json

from app.entities import find_or_create_album, find_or_create_artist, find_or_create_genre
from app.scanner import Edited

UNDO_KEY = "bulk_undo"
UNDO_LIMIT = 20_000  # entries; a full-library apply fits with room to spare

# The row an apply needs: the overlay-relevant columns plus the artist/album
# NAMES (undo entries store names — an emptied entity's row gets pruned and
# find-or-create recreates it on undo) and the track's primary genre name
# (undo restores it the same way).
APPLY_SELECT = """
SELECT t.id, t.title, t.artist_id, t.album_id, t.album_artist_id, t.track_no,
       t.year, t.artwork_id, t.user_edited, t.favorite, t.favorite_position,
       ar.name AS artist, al.title AS album,
       aar.name AS album_artist_name,
       (SELECT g.name FROM track_genres tg
        JOIN genres g ON g.id = tg.genre_id
        WHERE tg.track_id = t.id ORDER BY tg.genre_id LIMIT 1) AS genre
FROM tracks t
LEFT JOIN artists ar ON ar.id = t.artist_id
LEFT JOIN albums al ON al.id = t.album_id
LEFT JOIN artists aar ON aar.id = t.album_artist_id
"""


class FieldError(ValueError):
    """A field value the API must reject with 422. The bulk apply relies on
    it being raised BEFORE any commit for all-or-nothing semantics."""


def apply_field_changes(conn, track, fields: dict) -> dict:
    """Resolve `fields` against one track row into UPDATE columns.

    A key's presence in `fields` means "apply it"; absence leaves the column
    untouched. `track` needs title, artist_id, album_id, album_artist_id,
    track_no, year, artwork_id, user_edited. Empty result = nothing would
    change; raises FieldError on invalid values.
    """
    edited = Edited(track["user_edited"])
    columns: dict = {}

    if "title" in fields:
        title = (fields["title"] or "").strip()
        if not title:
            raise FieldError("Title cannot be empty")
        columns["title"] = title
        edited |= Edited.TITLE

    if "artist" in fields:
        columns["artist_id"] = find_or_create_artist(conn, fields["artist"])
        edited |= Edited.ARTIST
        # The old primary's main credit is replaced by the new artist, and
        # that artist can't double up as featured/composer on the same track.
        conn.execute(
            "DELETE FROM track_artists WHERE track_id = ? AND role = 'main'",
            (track["id"],),
        )
        new_artist_id = columns["artist_id"]
        if new_artist_id is not None:
            conn.execute(
                "DELETE FROM track_artists WHERE track_id = ? AND artist_id = ?",
                (track["id"], new_artist_id),
            )
            conn.execute(
                "INSERT INTO track_artists (track_id, artist_id, role, position) "
                "VALUES (?, ?, 'main', 0)",
                (track["id"], new_artist_id),
            )

    if "track_no" in fields:
        track_no = fields["track_no"]
        if track_no is not None and track_no < 0:
            raise FieldError("Track number cannot be negative")
        columns["track_no"] = track_no or None
        edited |= Edited.TRACK_NO

    if "album" in fields:
        # Re-groups this track only. The album keeps the track's album
        # artist (that follows tags); a fresh album inherits facts.
        columns["album_id"] = find_or_create_album(
            conn, fields["album"], track["album_artist_id"], track["year"]
        )
        artwork_id = track["artwork_id"]
        if columns["album_id"] is not None and artwork_id is not None:
            conn.execute(
                "UPDATE albums SET artwork_id = ? WHERE id = ? AND artwork_id IS NULL",
                (artwork_id, columns["album_id"]),
            )
        edited |= Edited.ALBUM

    if "album_artist" in fields:
        # The album artist is the album's identity: setting it pins the
        # track's overlay value AND moves the album row, so every view that
        # reads the album reads the same answer. An empty value clears both.
        artist_id = find_or_create_artist(conn, fields["album_artist"])
        columns["album_artist_id"] = artist_id
        if track["album_id"] is not None:
            conn.execute(
                "UPDATE albums SET artist_id = ? WHERE id = ?",
                (artist_id, track["album_id"]),
            )
        edited |= Edited.ALBUM_ARTIST

    if "favorite" in fields and fields["favorite"] is not None:
        favorite = int(bool(fields["favorite"]))
        # Only a real transition writes the flag — a re-set of the state the
        # row already holds is a no-op (an empty columns dict tells the
        # caller nothing changed).
        if favorite != (track["favorite"] or 0):
            columns["favorite"] = favorite
        # Favorites manual order: loving a track appends it after the last
        # placed favorite; unloving releases the slot. Like `favorite`, the
        # position lives outside the overlay — the scanner never touches it.
        if favorite and track["favorite_position"] is None:
            last = conn.execute(
                "SELECT MAX(favorite_position) AS m FROM tracks "
                "WHERE favorite = 1 AND favorite_position IS NOT NULL"
            ).fetchone()["m"]
            columns["favorite_position"] = (last or 0) + 1
        elif not favorite:
            columns["favorite_position"] = None

    # Replace the track's tag genres with the one named (empty clears). This
    # is row work in track_genres, not a tracks column: the flag rides
    # user_edited below so the caller's UPDATE still runs and the scanner
    # preserves the choice.
    genre_touched = False
    if "genre" in fields:
        name = (fields["genre"] or "").strip()
        conn.execute("DELETE FROM track_genres WHERE track_id = ?", (track["id"],))
        if name:
            genre_id = find_or_create_genre(conn, name)
            if genre_id is not None:
                conn.execute(
                    "INSERT OR IGNORE INTO track_genres (track_id, genre_id) "
                    "VALUES (?, ?)",
                    (track["id"], genre_id),
                )
        edited |= Edited.GENRE
        genre_touched = True

    if columns or genre_touched:
        columns["user_edited"] = int(edited)
    return columns


# One-generation undo: the last bulk apply stores each touched track's
# PREVIOUS values in the same wire vocabulary, so undo re-applies them
# through the exact same code path (re-setting the overlay bits — the
# result is a value the user chose, which is what the bit means).


def store_undo(conn, entries: list[dict]) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (UNDO_KEY, json.dumps({"entries": entries[:UNDO_LIMIT]})),
    )


def pop_undo(conn) -> list[dict]:
    """Return the stored entries and clear the slot. Empty list = nothing."""
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (UNDO_KEY,)).fetchone()
    conn.execute("DELETE FROM settings WHERE key = ?", (UNDO_KEY,))
    if row is None:
        return []
    try:
        entries = json.loads(row["value"]).get("entries", [])
    except (ValueError, TypeError):
        return []
    return entries if isinstance(entries, list) else []
