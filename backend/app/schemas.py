"""Pydantic response models — the OpenAPI contract that generates the
frontend TS client (DESIGN.md §6)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ScanStatus(BaseModel):
    state: Literal["idle", "scanning"]
    phase: Literal["scan", "watch"] | None
    current: int
    total: int
    errors: int
    finished_at: str | None


class LibraryCounts(BaseModel):
    tracks: int
    albums: int
    artists: int
    playlists: int


class SettingsOut(BaseModel):
    library_path: str
    library_exists: bool
    scan: ScanStatus
    counts: LibraryCounts


class ScanTriggered(BaseModel):
    state: Literal["scanning"]


# ---- Library (Milestone 3) ---------------------------------------------------


class TrackOut(BaseModel):
    id: int
    title: str
    artist: str | None
    artist_id: int | None
    album: str | None
    album_id: int | None
    track_no: int | None
    disc_no: int | None
    year: int | None
    duration: float
    format: str
    favorite: bool
    artwork_id: int | None


class TrackListOut(BaseModel):
    items: list[TrackOut]
    total: int
    limit: int
    offset: int


class AlbumSummary(BaseModel):
    id: int
    title: str
    artist: str | None
    artist_id: int | None
    year: int | None
    artwork_id: int | None
    track_count: int


class AlbumListOut(BaseModel):
    items: list[AlbumSummary]
    total: int
    limit: int
    offset: int


class AlbumDetail(AlbumSummary):
    duration_total: float
    tracks: list[TrackOut]


class ArtistSummary(BaseModel):
    id: int
    name: str
    album_count: int
    track_count: int


class ArtistListOut(BaseModel):
    items: list[ArtistSummary]
    total: int
    limit: int
    offset: int


class ArtistDetail(ArtistSummary):
    albums: list[AlbumSummary]
    tracks: list[TrackOut]


# ---- Track editing (Milestone 4) ---------------------------------------------


class TrackPatch(BaseModel):
    """Get Info / inline-rename payload (DESIGN.md §6, §13.2).

    artist/album are name strings — the editor find-or-creates rows. Only
    fields the client sends are applied; sent overlay fields set their
    `user_edited` bit so rescans preserve them."""
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    track_no: int | None = None
    favorite: bool | None = None


# ---- Organize view: bulk apply + review (§22) --------------------------------


class BulkApplyIn(BaseModel):
    """Mass edit from the Organize view (§22). Selection is either explicit
    `track_ids` or the same filter contract as GET /api/tracks minus
    pagination (`q` / `artist_id` / `album_id` / `review`, minus
    `except_ids`) — so a filter-wide apply touches exactly what the grid
    showed. Change fields carry the §15.2 semantics via the shared apply
    path: a field absent from the JSON never touches the column; an
    explicit null clears the track number; empty artist/album strings clear
    the reference; 0 normalizes to null. `favorite` is intentionally not a
    bulk field."""
    track_ids: list[int] | None = None
    q: str | None = None
    artist_id: int | None = None
    album_id: int | None = None
    review: str | None = None
    except_ids: list[int] = []
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    track_no: int | None = None


class BulkApplyOut(BaseModel):
    applied: int


class AlbumRef(BaseModel):
    id: int
    title: str
    track_count: int


class CollisionGroup(BaseModel):
    """Albums whose titles collapse onto one normalized key (§22): the
    scanner groups on exact strings, so suffix variants become siblings."""
    key: str
    albums: list[AlbumRef]


class ReviewSummary(BaseModel):
    """The "Needs attention" strip (§22). Deterministic counts only — no
    fuzzy matching. `undo_available` rides along: the view needs both on
    load, and undo state lives server-side (one generation)."""
    no_album: int
    single_track_albums: int
    mixed_album_artist_albums: int
    missing_track_no: int
    suffix_collisions: int
    collision_groups: list[CollisionGroup]
    undo_available: bool


# ---- Playlists (Milestone 4) ---------------------------------------------------


class PlaylistSummary(BaseModel):
    id: int
    name: str
    description: str | None
    # Canonical (trimmed, case-insensitively deduped) — edited in Manage.
    tags: list[str]
    created_at: str
    track_count: int
    duration_total: float
    # User-set cover; overrides the 2×2 card mosaic while set (§13.10).
    cover_artwork_id: int | None
    # Up to four artwork ids, in playlist order — the 2×2 card mosaic (§13.10).
    artwork_ids: list[int]


class PlaylistListOut(BaseModel):
    items: list[PlaylistSummary]
    total: int
    limit: int
    offset: int


class PlaylistTrackOut(TrackOut):
    position: int


class PlaylistDetail(PlaylistSummary):
    tracks: list[PlaylistTrackOut]


class PlaylistCreate(BaseModel):
    name: str
    description: str | None = None


class PlaylistUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    # Null resets the custom cover back to the track mosaic.
    cover_artwork_id: int | None = None


class PlaylistTracksIn(BaseModel):
    track_ids: list[int]


class PlaylistOrderIn(BaseModel):
    track_ids: list[int]


# ---- Search (Milestone 4) ------------------------------------------------------


class SearchOut(BaseModel):
    query: str
    tracks: list[TrackOut]
    albums: list[AlbumSummary]
    artists: list[ArtistSummary]
    playlists: list[PlaylistSummary]
