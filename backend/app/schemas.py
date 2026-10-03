"""Pydantic response models — the OpenAPI contract that generates the
frontend TS client (DESIGN.md §6)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ScanStatus(BaseModel):
    state: Literal["idle", "scanning"]
    # "analyze" = the post-scan loudness pass (§2.3); the index is already
    # correct, gains are being filled in behind it.
    phase: Literal["scan", "watch", "analyze"] | None
    current: int
    total: int
    errors: int
    finished_at: str | None
    # True when the last scan hit the broken-mount guard (§2.8): the calm,
    # explicit state Settings explains instead of a bare error count.
    mount_guard: bool = False


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


class ScanErrorEntry(BaseModel):
    path: str
    reason: str


class ScanErrorLog(BaseModel):
    """Skipped files of the last scan, for Settings' disclosure (§2.8)."""

    total: int
    truncated: bool
    items: list[ScanErrorEntry]


# ---- Library (Milestone 3) ---------------------------------------------------


class TrackOut(BaseModel):
    id: int
    title: str
    artist: str | None
    artist_id: int | None
    album: str | None
    album_id: int | None
    # The track's own album-artist tag value (§2.2) — the compilation
    # semantics Get Info and the bulk editor pin.
    album_artist: str | None = None
    track_no: int | None
    disc_no: int | None
    year: int | None
    duration: float
    format: str
    favorite: bool
    artwork_id: int | None
    # File path relative to the library root (Organize view, §22).
    path: str
    # Sound Check loudness offset in dB (§2.3) — NULL until measured.
    gain_db: float | None = None
    # Last real playback start (§4.1): private, count-free recency. NULL
    # until the track has been played on this server; rescans never touch it.
    played_at: str | None = None
    # The track's primary genre (§2.2): the first tag genre, the one the
    # Tracks filter groups by. NULL = untagged. Editable in Organize.
    genre: str | None = None
    # When the scanner first saw the file (§22) — the Organize view's
    # "latest added first" ordering.
    added_at: str | None = None


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
    # The album's most recent play (§4.1) — recency sorts and the Home
    # "Recently played" module. NULL = never played on this server.
    played_at: str | None = None
    # User-set cover (2026-10-03): overrides the scan-derived `artwork_id`
    # while set, exactly as a playlist's cover overrides its track mosaic.
    cover_artwork_id: int | None = None


class AlbumListOut(BaseModel):
    items: list[AlbumSummary]
    total: int
    limit: int
    offset: int


class AlbumDetail(AlbumSummary):
    duration_total: float
    tracks: list[TrackOut]


class AlbumUpdate(BaseModel):
    # Null restores the scan-derived artwork (the cover-reset verb).
    cover_artwork_id: int | None = None


class ArtistSummary(BaseModel):
    id: int
    name: str
    album_count: int
    track_count: int
    # The latest album's cover, as the artist's stand-in portrait (the Artists
    # grid reads as a wall of circular covers, Apple-Music style). None → the
    # client renders a monogram.
    artwork_id: int | None = None
    # User-set portrait (2026-10-03): overrides `artwork_id` while set —
    # the same override a playlist's cover applies to its track mosaic.
    cover_artwork_id: int | None = None


class ArtistListOut(BaseModel):
    items: list[ArtistSummary]
    total: int
    limit: int
    offset: int


class ArtistDetail(ArtistSummary):
    albums: list[AlbumSummary]
    tracks: list[TrackOut]


class ArtistUpdate(BaseModel):
    # Null restores the derived portrait (the latest album's cover).
    cover_artwork_id: int | None = None


# ---- Genres (UX review §2.2) -------------------------------------------------


class GenreSummary(BaseModel):
    id: int
    name: str
    track_count: int
    album_count: int
    # A representative cover from the genre's albums — the grid stays
    # art-first, per §8.1.
    artwork_id: int | None = None


class GenreListOut(BaseModel):
    items: list[GenreSummary]
    total: int
    limit: int
    offset: int


# ---- Track editing (Milestone 4) ---------------------------------------------


class TrackPatch(BaseModel):
    """Get Info / inline-rename payload (DESIGN.md §6, §13.2).

    artist/album are name strings — the editor find-or-creates rows. Only
    fields the client sends are applied; sent overlay fields set their
    `user_edited` bit so rescans preserve them. `album_artist` pins a
    compilation's identity (§2.2); an empty string clears it. `genre`
    replaces the track's tag genres with the one named (empty clears)."""
    title: str | None = None
    artist: str | None = None
    album_artist: str | None = None
    album: str | None = None
    track_no: int | None = None
    favorite: bool | None = None
    genre: str | None = None


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
    album_artist: str | None = None
    album: str | None = None
    track_no: int | None = None
    genre: str | None = None


class BulkApplyOut(BaseModel):
    applied: int


class TrackReorderIn(BaseModel):
    """Organize drag-reorder (§22): the album's tracks in their new order.
    Each track's number is rewritten to its position in the list (1..n) and
    flagged user-edited, so a rescan preserves it."""
    track_ids: list[int]


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


# ---- The server-truth play queue (UX review Part 4.0) --------------------------

class QueueOrigin(BaseModel):
    """Where the queue came from (UX review 2, Part 1.1): the "Playing from"
    sentence. `label` is the human name ("Album 03", "Everything, shuffled");
    `href` is the route that makes the label a link. `manual` (a hand-built
    queue) carries no label — nothing renders, exactly as before this
    column existed."""

    kind: Literal["album", "artist", "playlist", "filter", "shuffle-all", "manual"]
    label: str | None = None
    href: str | None = None


class QueueSnapshot(BaseModel):
    """The whole stored session — what GET /api/queue restores and what the
    play/replace endpoints echo back. `items` are the queue in insertion
    order; `order` is the play order as indexes into `items` (identity, or
    the shuffle plan); `order_pos` indexes `order` (-1 = built, nothing
    loaded); `position` is seconds into the current track. `origin` names
    what produced the queue (§1.1) — null for sessions that predate it. The
    client store adopts this shape verbatim."""

    items: list[TrackOut]
    order: list[int]
    order_pos: int
    position: float
    origin: QueueOrigin | None = None
    updated_at: str | None = None


class QueuePlayIn(BaseModel):
    """POST /api/queue — "play this view" (§4.0). Exactly one of `track_ids`
    or the GET /api/tracks filter contract (minus pagination). The server
    resolves the WHOLE filter in one query — there is no page for the queue
    to be silently truncated to (§1.2, for good). `start` is the index into
    the resolved list that begins playback; `shuffle` builds the play order
    starting there instead. `origin` is the caller's declaration of what
    this view IS (the client knows; the server records, §1.1)."""

    track_ids: list[int] | None = None
    q: str | None = None
    artist_id: int | None = None
    album_id: int | None = None
    review: str | None = None
    favorite: bool | None = None
    genre_id: int | None = None
    sort: str = "title"
    dir: str = "asc"
    start: int = 0
    shuffle: bool = False
    origin: QueueOrigin | None = None


class QueuePutIn(BaseModel):
    """PUT /api/queue — the client's plan mirror (§32). The store remains the
    source of UI truth and PUTs its whole queue when the plan changes (the
    §29 cadence, server-destination instead of localStorage-only). `order`
    must be a permutation of 0..n-1 into `track_ids`. `origin` rides along
    unchanged — queue edits never rewrite where the queue came from."""

    track_ids: list[int]
    order: list[int]
    order_pos: int
    position: float = 0
    origin: QueueOrigin | None = None


class QueuePatchIn(BaseModel):
    """PATCH /api/queue — the playhead, at the §29 cadence (3 s throttle plus
    a pagehide flush). `played_track_id` rides the immediate start-of-play
    sync: when present, the server stamps tracks.played_at (§4.1) on THAT id
    — carried explicitly, never derived from the stored plan, so a mirror
    PUT still in flight cannot mis-stamp."""

    order_pos: int | None = None
    position: float | None = None
    played_track_id: int | None = None


class QueuePlayheadOut(BaseModel):
    """PATCH's answer — tiny, because it rides the 3 s cadence."""

    order_pos: int
    position: float
    updated_at: str | None = None
