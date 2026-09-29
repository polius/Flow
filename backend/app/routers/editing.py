"""Track editing: PATCH /api/tracks/{id} (DESIGN.md §6, §13.2).

The overlay contract: edited title/artist/album/track_no are written to the
track row and flagged in `user_edited`, so the scanner preserves them on
rescans (§5). Artist/album are accepted as name strings and resolved with
find-or-create — re-grouping touches this track only, and entities left
empty by the move are pruned. Favorite is a plain flag, not part of the
overlay (rescans never touch it).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.entities import find_or_create_album, find_or_create_artist, prune_orphans
from app.routers.library import TRACK_SELECT, track_out
from app.schemas import TrackOut, TrackPatch
from app.scanner import Edited

router = APIRouter(tags=["editing"])


@router.patch("/api/tracks/{track_id}", response_model=TrackOut)
def patch_track(request: Request, track_id: int, patch: TrackPatch) -> TrackOut:
    conn = request.app.state.db.connect()
    track = conn.execute(
        "SELECT id, title, artist_id, album_id, album_artist_id, track_no, "
        "year, artwork_id, user_edited FROM tracks WHERE id = ?",
        (track_id,),
    ).fetchone()
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    fields: dict = {}
    bits = Edited(track["user_edited"])

    if patch.title is not None:
        title = patch.title.strip()
        if not title:
            raise HTTPException(status_code=422, detail="Title cannot be empty")
        fields["title"] = title
        bits |= Edited.TITLE

    if patch.artist is not None:
        fields["artist_id"] = find_or_create_artist(conn, patch.artist)
        bits |= Edited.ARTIST

    if "track_no" in patch.model_fields_set:
        # Explicit null clears the number (Get Info blank field); an absent
        # field leaves it untouched. 0 normalizes to null.
        if patch.track_no is not None and patch.track_no < 0:
            raise HTTPException(status_code=422, detail="Track number cannot be negative")
        fields["track_no"] = patch.track_no or None
        bits |= Edited.TRACK_NO

    if patch.album is not None:
        # §13.2: re-groups this track only. The album keeps the track's album
        # artist (that follows tags); a fresh album inherits track facts.
        fields["album_id"] = find_or_create_album(
            conn, patch.album, track["album_artist_id"], track["year"]
        )
        new_artwork = track["artwork_id"]
        if new_artwork is not None:
            conn.execute(
                "UPDATE albums SET artwork_id = ? WHERE id = ? AND artwork_id IS NULL",
                (new_artwork, fields["album_id"]),
            )
        bits |= Edited.ALBUM

    if patch.favorite is not None:
        fields["favorite"] = int(patch.favorite)

    if fields or bits != track["user_edited"]:
        fields["user_edited"] = int(bits)
        sets = ", ".join(f"{col} = ?" for col in fields)
        conn.execute(
            f"UPDATE tracks SET {sets} WHERE id = ?", (*fields.values(), track_id)
        )
        prune_orphans(conn)
        conn.commit()

    row = conn.execute(f"{TRACK_SELECT} WHERE t.id = ?", (track_id,)).fetchone()
    return track_out(row)
