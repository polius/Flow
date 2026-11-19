"""Library settings + scan state."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app import config, scrobble
from app.routers.common import TxRoute
from app.schemas import (
    LibraryCounts,
    ListenBrainzIn,
    ListenBrainzStatus,
    ScanStatus,
    SettingsOut,
)

router = APIRouter(tags=["settings"], route_class=TxRoute)


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
        plays=conn.execute("SELECT COUNT(*) c FROM plays").fetchone()["c"],
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
        listenbrainz=ListenBrainzStatus(**scrobble.status(conn)),
    )


@router.put("/api/listenbrainz", response_model=ListenBrainzStatus)
def put_listenbrainz(request: Request, body: ListenBrainzIn) -> ListenBrainzStatus:
    """Save a ListenBrainz token (checked with ListenBrainz first), or with
    null turn scrobbling off. The only request Flow makes to the outside
    before a token is saved is this check, on the owner's say-so."""
    conn = request.app.state.db.connect()
    tok = body.token.strip() if body.token is not None else None
    if tok:
        try:
            known = scrobble.validate(tok)
        except OSError as exc:
            raise HTTPException(status_code=502, detail="Couldn't reach ListenBrainz") from exc
        if not known:
            raise HTTPException(status_code=400, detail="ListenBrainz didn't accept this token")
    scrobble.set_token(conn, tok or None)
    conn.commit()
    return ListenBrainzStatus(**scrobble.status(conn))
