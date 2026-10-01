"""Track editing (DESIGN.md §6, §13.2, §22).

PATCH /api/tracks/{id} — the Get Info editor. Bulk apply + undo + the
review summary — the Organize view. Both editors resolve fields through
app.apply's single implementation, so overlay semantics (§15.2) can never
diverge: edited values land in SQLite flagged in `user_edited`, the scanner
preserves them on rescans, and files are never touched.

The Organize view's bulk endpoint is deliberately one transaction: a
validation failure (an empty title among ten thousand rows) writes nothing.
The last bulk apply is stored (one generation) so the view can offer Undo;
undo re-applies the previous values through the same shared path.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request

from app.apply import (
    APPLY_SELECT,
    FieldError,
    apply_field_changes,
    pop_undo,
    store_undo,
)
from app.entities import prune_orphans
from app.routers.library import TRACK_SELECT, track_filter_where, track_out
from app.schemas import (
    AlbumRef,
    BulkApplyIn,
    BulkApplyOut,
    CollisionGroup,
    ReviewSummary,
    TrackOut,
    TrackPatch,
)
from app.apply import UNDO_KEY

router = APIRouter(tags=["editing"])

# Rows needed to apply fields, plus the artist/album NAMES the undo entries
# store (an emptied entity's row is pruned; undo recreates it by name).
_CHUNK = 500


def _chunks(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _run_update(conn, row, columns: dict) -> None:
    sets = ", ".join(f"{col} = ?" for col in columns)
    conn.execute(f"UPDATE tracks SET {sets} WHERE id = ?", (*columns.values(), row["id"]))


# ---- single-track editor (Get Info, §9.3) ------------------------------------


@router.patch("/api/tracks/{track_id}", response_model=TrackOut)
def patch_track(request: Request, track_id: int, patch: TrackPatch) -> TrackOut:
    conn = request.app.state.db.connect()
    track = conn.execute(f"{APPLY_SELECT} WHERE t.id = ?", (track_id,)).fetchone()
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    # Wire semantics → fields dict (§15.2): a null title/artist/album is an
    # absent field (no-op); the track number honours explicit null because
    # the Get Info panel blanks it to clear.
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

    try:
        columns = apply_field_changes(conn, track, fields)
    except FieldError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if columns:
        _run_update(conn, track, columns)
        prune_orphans(conn)
        conn.commit()

    row = conn.execute(f"{TRACK_SELECT} WHERE t.id = ?", (track_id,)).fetchone()
    return track_out(row)


# ---- bulk apply (Organize view, §22) ------------------------------------------


def _old_value(key: str, row) -> object:
    """The wire-vocabulary previous value for an undo entry: empty strings
    mean "was unset" for artist/album, explicit null for the track number."""
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
    return None


def _resolve_ids(conn, body: BulkApplyIn) -> list[int]:
    """Explicit ids, or the filter contract of GET /api/tracks (minus
    pagination) minus except_ids — a filter-wide apply must touch exactly
    what the grid showed."""
    if body.track_ids is not None:
        return sorted(set(body.track_ids) - set(body.except_ids))
    clause, params = track_filter_where(
        q=body.q, artist_id=body.artist_id, album_id=body.album_id, review=body.review
    )
    rows = conn.execute(
        "SELECT t.id FROM tracks t "
        "LEFT JOIN artists ar ON ar.id = t.artist_id "
        "LEFT JOIN albums al ON al.id = t.album_id "
        f"{clause}",
        params,
    ).fetchall()
    return sorted({r["id"] for r in rows} - set(body.except_ids))


@router.post("/api/tracks/bulk", response_model=BulkApplyOut)
def bulk_apply_tracks(request: Request, body: BulkApplyIn) -> BulkApplyOut:
    conn = request.app.state.db.connect()

    # Wire semantics → fields dict, exactly as the PATCH handler does.
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
    if not fields:
        raise HTTPException(status_code=422, detail="No changes provided")

    ids = _resolve_ids(conn, body)

    applied = 0
    undo_entries: list[dict] = []
    try:
        for chunk in _chunks(ids, _CHUNK):
            placeholders = ", ".join("?" * len(chunk))
            rows = conn.execute(
                f"{APPLY_SELECT} WHERE t.id IN ({placeholders})", chunk
            ).fetchall()
            for row in rows:
                undo_entries.append(
                    {"id": row["id"], "fields": {k: _old_value(k, row) for k in fields}}
                )
                columns = apply_field_changes(conn, row, fields)
                if not columns:
                    continue
                _run_update(conn, row, columns)
                applied += 1
        if applied:
            prune_orphans(conn)
            store_undo(conn, undo_entries)
        conn.commit()
    except FieldError as exc:
        conn.rollback()
        raise HTTPException(status_code=422, detail=str(exc))

    return BulkApplyOut(applied=applied)


@router.post("/api/tracks/bulk/undo", response_model=BulkApplyOut)
def bulk_undo(request: Request) -> BulkApplyOut:
    conn = request.app.state.db.connect()
    entries = pop_undo(conn)
    if not entries:
        conn.commit()
        raise HTTPException(status_code=404, detail="Nothing to undo")

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
                columns = apply_field_changes(conn, row, entry["fields"])
            except FieldError:
                continue
            if not columns:
                continue
            _run_update(conn, row, columns)
            applied += 1

    prune_orphans(conn)
    conn.commit()
    return BulkApplyOut(applied=applied)


# ---- review summary ("Needs attention", §22) -----------------------------------

_COLLISION_SUFFIX = re.compile(
    r"\s*[\(\[][^\)\]]*?(?:deluxe|remast|expand|anniversar|edition|bonus"
    r"|explicit|special|version)[^\)\]]*?[\)\]]",
    re.IGNORECASE,
)


def _normalize_album_title(title: str) -> str:
    """Deterministic collapse for near-duplicate album titles: strip
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
    missing_track_no = count("SELECT COUNT(*) AS c FROM tracks WHERE track_no IS NULL")
    single_track_albums = count(
        "SELECT COUNT(*) AS c FROM (SELECT album_id FROM tracks "
        "WHERE album_id IS NOT NULL GROUP BY album_id HAVING COUNT(*) = 1)"
    )
    mixed_album_artist_albums = count(
        "SELECT COUNT(*) AS c FROM (SELECT album_id FROM tracks "
        "WHERE album_id IS NOT NULL GROUP BY album_id "
        "HAVING COUNT(DISTINCT COALESCE(album_artist_id, -1)) > 1)"
    )

    # Suffix variants: group all albums by normalized title. Same-titled
    # albums by DIFFERENT artists are legitimate (two "Greatest Hits" rows),
    # so a group only counts as a collision when members share an artist.
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
        missing_track_no=missing_track_no,
        suffix_collisions=len(collisions),
        collision_groups=collisions[:24],
        undo_available=undo_row is not None,
    )
