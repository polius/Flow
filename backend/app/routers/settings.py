"""Library settings + scan state."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app import config
from app.schemas import LibraryCounts, ScanStatus, SettingsOut

router = APIRouter(tags=["settings"])


@router.get("/api/settings", response_model=SettingsOut)
def get_settings(request: Request) -> SettingsOut:
    db = request.app.state.db
    scanner = request.app.state.scanner

    conn = db.connect()
    persisted = {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM settings")
    }
    event = scanner.current_state_event()

    counts = LibraryCounts(
        tracks=conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"],
        albums=conn.execute("SELECT COUNT(*) c FROM albums").fetchone()["c"],
        artists=conn.execute("SELECT COUNT(*) c FROM artists").fetchone()["c"],
        playlists=conn.execute("SELECT COUNT(*) c FROM playlists").fetchone()["c"],
    )
    scan = ScanStatus(
        state=event["state"],
        phase=event["phase"],
        current=event["current"],
        total=event["total"],
        errors=event["errors"],
        finished_at=event["finished_at"] or None,
        mount_guard=bool(event.get("mount_guard", False)),
    )
    return SettingsOut(
        library_path=persisted.get("library_path", str(config.MUSIC_DIR)),
        library_exists=config.MUSIC_DIR.is_dir(),
        scan=scan,
        counts=counts,
    )
