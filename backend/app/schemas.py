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
