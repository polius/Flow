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
