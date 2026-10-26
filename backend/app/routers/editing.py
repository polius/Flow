"""Track editing: single-track PATCH, bulk apply, reorder — every write
lands one server-side undo generation (settings.bulk_undo), so ⌘Z and the
undo toast always reverse the most recent change, whatever its size."""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request

from app.apply import (
    APPLY_SELECT,
    ENTITY_FIELDS,
    FieldError,
    apply_field_changes,
    pop_undo,
    store_undo,
)
from app.entities import prune_orphans
from app.routers.common import TxRoute, chunks as _chunks
from app.routers.library import (
    TRACK_FILTER_FROM,
    TRACK_SELECT,
    track_filter_where,
    track_out,
)
from app.schemas import (
    AlbumRef,
    BulkApplyIn,
    BulkApplyOut,
    CollisionGroup,
    FavoritesBulkIn,
    FavoritesBulkOut,
    ReviewSummary,
    TrackOut,
    TrackPatch,
    TrackReorderIn,
)
from app.apply import UNDO_KEY
from app.db import retry_locked
from app.scanner import Edited

router = APIRouter(tags=["editing"], route_class=TxRoute)

# Undo entries store artist/album NAMES: an emptied entity's row is pruned,
# so undo recreates it by name.
_CHUNK = 500


def _run_update(conn, row, columns: dict) -> None:
    sets = ", ".join(f"{col} = ?" for col in columns)
    conn.execute(f"UPDATE tracks SET {sets} WHERE id = ?", (*columns.values(), row["id"]))


# ---- single-track editor (Get Info) ------------------------------------------


@router.patch("/api/tracks/{track_id}", response_model=TrackOut)
def patch_track(request: Request, track_id: int, patch: TrackPatch) -> TrackOut:
    conn = request.app.state.db.connect()
    track = conn.execute(f"{APPLY_SELECT} WHERE t.id = ?", (track_id,)).fetchone()
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    # A null title/artist/album is an absent field (no-op); track_no honours
    # explicit null because the Get Info panel blanks it to clear.
    fields: dict = {}
    if patch.title is not None:
        fields["title"] = patch.title
    if patch.artist is not None:
        fields["artist"] = patch.artist
    if patch.album_artist is not None:
        fields["album_artist"] = patch.album_artist
    if "track_no" in patch.model_fields_set:
        fields["track_no"] = patch.track_no
    if patch.album is not None:
        fields["album"] = patch.album
    if patch.favorite is not None:
        fields["favorite"] = patch.favorite
    if patch.genre is not None:
        fields["genre"] = patch.genre

    # One retrying transaction: the apply's writes + the prune land together,
    # and a busy scan's lock window is out-waited, not 500'd on.
    def _apply() -> dict:
        siblings: list[dict] = []
        cols = apply_field_changes(conn, track, fields, sibling_undo=siblings)
        if cols:
            _run_update(conn, track, cols)
            # Title, number and heart edits can't orphan an entity row —
            # skip the whole-table prune for them.
            if fields.keys() & ENTITY_FIELDS:
                prune_orphans(conn)
            # Single edits join the same undo generation as bulk applies:
            # metadata fields only — the favorite heart carries its own
            # client-side undo and must not clobber a pending generation.
            undo_fields = {k: v for k, v in fields.items() if k != "favorite"}
            if undo_fields:
                store_undo(
                    conn,
                    [
                        {
                            "id": track_id,
                            "fields": {k: _old_value(k, track) for k in undo_fields},
                            "user_edited": track["user_edited"],
                        },
                        *siblings,
                    ],
                )
        conn.commit()
        return cols

    try:
        columns = retry_locked(conn, _apply)
    except FieldError as exc:
        conn.rollback()
        raise HTTPException(status_code=422, detail=str(exc))

    row = conn.execute(f"{TRACK_SELECT} WHERE t.id = ?", (track_id,)).fetchone()
    return track_out(row)


# ---- bulk apply (Organize view) ------------------------------------------


def _old_value(key: str, row) -> object:
    """Previous value for an undo entry, in wire vocabulary: empty string
    means "was unset" for artist/album, explicit null for the track number."""
    if key == "title":
        return row["title"]
    if key == "artist":
        return row["artist"] or ""
    if key == "album":
        return row["album"] or ""
    if key == "album_artist":
        return row["album_artist_name"] or ""
    if key == "track_no":
        return row["track_no"]
    if key == "genre":
        return row["genre"] or ""
    return None


def _resolve_ids(conn, body: BulkApplyIn) -> list[int]:
    """Explicit ids, or the GET /api/tracks filter (minus pagination) minus
    except_ids — a filter-wide apply must match exactly what the grid showed."""
    if body.track_ids is not None:
        return sorted(set(body.track_ids) - set(body.except_ids))
    clause, params = track_filter_where(
        q=body.q, artist_id=body.artist_id, album_id=body.album_id, review=body.review
    )
    rows = conn.execute(f"SELECT t.id {TRACK_FILTER_FROM} {clause}", params).fetchall()
    return sorted({r["id"] for r in rows} - set(body.except_ids))


@router.post("/api/tracks/bulk", response_model=BulkApplyOut)
def bulk_apply_tracks(request: Request, body: BulkApplyIn) -> BulkApplyOut:
    conn = request.app.state.db.connect()

    # Same fields mapping as the PATCH handler — keep in sync.
    fields: dict = {}
    if body.title is not None:
        fields["title"] = body.title
    if body.artist is not None:
        fields["artist"] = body.artist
    if body.album_artist is not None:
        fields["album_artist"] = body.album_artist
    if body.album is not None:
        fields["album"] = body.album
    if "track_no" in body.model_fields_set:
        fields["track_no"] = body.track_no
    if body.genre is not None:
        fields["genre"] = body.genre
    if not fields:
        raise HTTPException(status_code=422, detail="No changes provided")

    ids = _resolve_ids(conn, body)

    # One retrying transaction: all-or-nothing on both a validation failure
    # (nothing committed) and a lock window (rolled back, replayed whole).
    def _apply() -> tuple[int, bool]:
        applied = 0
        undo_stored = True
        # One list for the selection's own entries and the album siblings an
        # album-artist change rewrites; store_undo keeps each track's first
        # (pre-change) entry.
        undo_entries: list[dict] = []
        try:
            for chunk in _chunks(ids, _CHUNK):
                placeholders = ", ".join("?" * len(chunk))
                rows = conn.execute(
                    f"{APPLY_SELECT} WHERE t.id IN ({placeholders})", chunk
                ).fetchall()
                for row in rows:
                    undo_entries.append(
                        {
                            "id": row["id"],
                            "fields": {k: _old_value(k, row) for k in fields},
                            "user_edited": row["user_edited"],
                        }
                    )
                    columns = apply_field_changes(
                        conn, row, fields, sibling_undo=undo_entries
                    )
                    if not columns:
                        continue
                    _run_update(conn, row, columns)
                    applied += 1
            if applied:
                if fields.keys() & ENTITY_FIELDS:
                    prune_orphans(conn)
                undo_stored = store_undo(conn, undo_entries)
            conn.commit()
        except FieldError:
            conn.rollback()
            raise
        return applied, undo_stored

    try:
        applied, undo_stored = retry_locked(conn, _apply)
    except FieldError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return BulkApplyOut(applied=applied, undo_available=undo_stored)


@router.post("/api/tracks/bulk/undo", response_model=BulkApplyOut)
def bulk_undo(request: Request) -> BulkApplyOut:
    conn = request.app.state.db.connect()
    entries = pop_undo(conn)
    if not entries:
        conn.commit()
        raise HTTPException(status_code=404, detail="Nothing to undo")

    def _apply() -> int:
        applied = 0
        for chunk in _chunks(entries, _CHUNK):
            placeholders = ", ".join("?" * len(chunk))
            rows = {
                r["id"]: r
                for r in conn.execute(
                    f"{APPLY_SELECT} WHERE t.id IN ({placeholders})",
                    [e["id"] for e in chunk],
                )
            }
            for entry in chunk:
                row = rows.get(entry["id"])
                if row is None:
                    continue  # the track was removed since — skip, don't block
                try:
                    # Siblings carry their own entries: replay one track at
                    # a time, never re-propagating.
                    columns = apply_field_changes(
                        conn, row, entry["fields"], propagate=False
                    )
                except FieldError:
                    continue
                if not columns:
                    continue
                if isinstance(entry.get("user_edited"), int):
                    columns["user_edited"] = entry["user_edited"]
                _run_update(conn, row, columns)
                applied += 1
        prune_orphans(conn)
        conn.commit()
        return applied

    applied = retry_locked(conn, _apply)
    return BulkApplyOut(applied=applied)


# ---- drag-reorder within an album -----------------------------------------


@router.post("/api/tracks/reorder", response_model=BulkApplyOut)
def reorder_tracks(request: Request, body: TrackReorderIn) -> BulkApplyOut:
    """Renumber the given tracks 1..n in the order listed (flagged user-edited, preserved on rescan)."""
    conn = request.app.state.db.connect()
    if not body.track_ids:
        raise HTTPException(status_code=422, detail="track_ids must not be empty")

    # Dedupe, keep order; unknown ids are skipped (a rescan may have removed
    # one mid-gesture) rather than failing the whole block.
    ids = list(dict.fromkeys(body.track_ids))
    position_of = {tid: pos for pos, tid in enumerate(ids, start=1)}

    def _apply() -> int:
        applied = 0
        undo_entries: list[dict] = []
        for chunk in _chunks(ids, _CHUNK):
            placeholders = ", ".join("?" * len(chunk))
            # The pre-drag numbers are the undo entry: re-applying them is
            # the same overlay write the drag itself performs.
            rows = conn.execute(
                f"SELECT id, track_no, user_edited FROM tracks t WHERE t.id IN ({placeholders})",
                chunk,
            ).fetchall()
            undo_entries.extend(
                {
                    "id": r["id"],
                    "fields": {"track_no": r["track_no"]},
                    "user_edited": r["user_edited"],
                }
                for r in rows
            )
            for row in rows:
                edited = Edited(row["user_edited"]) | Edited.TRACK_NO
                conn.execute(
                    "UPDATE tracks SET track_no = ?, user_edited = ? WHERE id = ?",
                    (position_of[row["id"]], int(edited), row["id"]),
                )
                applied += 1
        undo_stored = store_undo(conn, undo_entries) if applied else True
        conn.commit()
        return applied, undo_stored

    applied, undo_stored = retry_locked(conn, _apply)
    return BulkApplyOut(applied=applied, undo_available=undo_stored)


# ---- Favorites manual order (drag & drop) ---------------------------------------


@router.post("/api/favorites/reorder", response_model=BulkApplyOut)
def reorder_favorites(request: Request, body: TrackReorderIn) -> BulkApplyOut:
    """Write the Favorites manual order; only currently loved tracks are placed."""
    conn = request.app.state.db.connect()
    if not body.track_ids:
        raise HTTPException(status_code=422, detail="track_ids must not be empty")

    # Dedupe, keep order; unknown ids simply place nothing.
    ids = list(dict.fromkeys(body.track_ids))
    position_of = {tid: pos for pos, tid in enumerate(ids, start=1)}

    def _apply() -> int:
        applied = 0
        for chunk in _chunks(ids, _CHUNK):
            placeholders = ", ".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT id FROM tracks WHERE favorite = 1 AND id IN ({placeholders})",
                chunk,
            ).fetchall()
            for row in rows:
                conn.execute(
                    "UPDATE tracks SET favorite_position = ? WHERE id = ?",
                    (position_of[row["id"]], row["id"]),
                )
                applied += 1
        conn.commit()
        return applied

    applied = retry_locked(conn, _apply)
    return BulkApplyOut(applied=applied)


@router.post("/api/favorites/bulk", response_model=FavoritesBulkOut)
def bulk_favorite(request: Request, body: FavoritesBulkIn) -> FavoritesBulkOut:
    """Love or unlove many tracks in one transaction (one request, one
    invalidation for a big selection). Loving appends to the manual order
    in the order given; unloving releases the slot. Unknown ids are
    ignored. Like the heart, this never joins the edit undo generation."""
    conn = request.app.state.db.connect()
    ids = list(dict.fromkeys(body.track_ids))
    want = 1 if body.favorite else 0

    def _apply() -> int:
        updated = 0
        last = conn.execute(
            "SELECT COALESCE(MAX(favorite_position), 0) AS m FROM tracks "
            "WHERE favorite = 1 AND favorite_position IS NOT NULL"
        ).fetchone()["m"]
        for chunk in _chunks(ids, _CHUNK):
            placeholders = ", ".join("?" * len(chunk))
            changing = {
                r["id"]
                for r in conn.execute(
                    f"SELECT id FROM tracks WHERE favorite != ? AND id IN ({placeholders})",
                    [want, *chunk],
                )
            }
            for tid in chunk:
                if tid not in changing:
                    continue
                if want:
                    last += 1
                    conn.execute(
                        "UPDATE tracks SET favorite = 1, favorite_position = ? WHERE id = ?",
                        (last, tid),
                    )
                else:
                    conn.execute(
                        "UPDATE tracks SET favorite = 0, favorite_position = NULL "
                        "WHERE id = ?",
                        (tid,),
                    )
                updated += 1
        conn.commit()
        return updated

    return FavoritesBulkOut(updated=retry_locked(conn, _apply))


# ---- review summary ("Needs attention") -----------------------------------

_COLLISION_SUFFIX = re.compile(
    r"\s*[\(\[][^\)\]]*?(?:deluxe|remast|expand|anniversar|edition|bonus"
    r"|explicit|special|version)[^\)\]]*?[\)\]]",
    re.IGNORECASE,
)


def _normalize_album_title(title: str) -> str:
    """Deterministic collapse of near-duplicate album titles: strip
    bracketed variant segments ("(Deluxe Edition)", "[Remastered]"), then
    punctuation and case. No fuzzy matching."""
    t = _COLLISION_SUFFIX.sub(" ", title)
    t = re.sub(r"[^\w]+", " ", t)
    return " ".join(t.casefold().split())


@router.get("/api/review/summary", response_model=ReviewSummary)
def review_summary(request: Request) -> ReviewSummary:
    conn = request.app.state.db.connect()

    def count(sql: str) -> int:
        return conn.execute(sql).fetchone()["c"]

    no_album = count("SELECT COUNT(*) AS c FROM tracks WHERE album_id IS NULL")
    single_track_albums = count(
        "SELECT COUNT(*) AS c FROM (SELECT album_id FROM tracks "
        "WHERE album_id IS NOT NULL GROUP BY album_id HAVING COUNT(*) = 1)"
    )
    mixed_album_artist_albums = count(
        "SELECT COUNT(*) AS c FROM (SELECT album_id FROM tracks "
        "WHERE album_id IS NOT NULL GROUP BY album_id "
        "HAVING COUNT(DISTINCT COALESCE(album_artist_id, -1)) > 1)"
    )

    # Same-titled albums by DIFFERENT artists are legitimate (two "Greatest
    # Hits" rows), so a group only counts as a collision when members share
    # an artist.
    rows = conn.execute(
        "SELECT al.id, al.title, al.artist_id, COUNT(t.id) AS track_count "
        "FROM albums al LEFT JOIN tracks t ON t.album_id = al.id "
        "GROUP BY al.id ORDER BY al.title COLLATE NOCASE"
    ).fetchall()
    grouped: dict[str, list[AlbumRef]] = {}
    artists: dict[str, set] = {}
    for r in rows:
        key = _normalize_album_title(r["title"])
        if not key:
            continue
        grouped.setdefault(key, []).append(
            AlbumRef(id=r["id"], title=r["title"], track_count=r["track_count"])
        )
        artists.setdefault(key, set()).add(r["artist_id"])

    collisions = [
        CollisionGroup(key=key, albums=members)
        for key, members in grouped.items()
        if len(members) > 1 and len(artists[key]) < len(members)
    ]
    collisions.sort(key=lambda g: (-sum(a.track_count for a in g.albums), g.key))

    undo_row = conn.execute("SELECT 1 FROM settings WHERE key = ?", (UNDO_KEY,)).fetchone()
    return ReviewSummary(
        no_album=no_album,
        single_track_albums=single_track_albums,
        mixed_album_artist_albums=mixed_album_artist_albums,
        suffix_collisions=len(collisions),
        collision_groups=collisions[:24],
        undo_available=undo_row is not None,
    )
