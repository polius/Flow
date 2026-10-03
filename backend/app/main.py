"""Flow — FastAPI application factory (DESIGN.md §6, §7).

Routers: scan/settings (M2), library/media (M3), editing/playlists/search (M4).
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import config
from app.db import Database
from app.events import ScanBus
from app.scanner import LibraryScanner
from app.routers import editing as editing_router
from app.routers import covers as covers_router
from app.routers import library as library_router
from app.routers import media as media_router
from app.routers import playlists as playlists_router
from app.routers import queue as queue_router
from app.routers import scan as scan_router
from app.routers import search as search_router
from app.routers import settings as settings_router
from app.watcher import LibraryWatcher

logging.basicConfig(
    level=os.environ.get("FLOW_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


def _bootstrap(db: Database) -> None:
    """Startup-time settings hygiene."""
    conn = db.connect()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('library_path', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(config.MUSIC_DIR),),
    )
    # A crash mid-scan must not leave the UI showing "scanning" forever.
    conn.execute(
        "UPDATE settings SET value = 'idle' WHERE key = 'scan_state' AND value = 'scanning'"
    )
    conn.commit()


def create_app() -> FastAPI:
    db = Database(config.DB_PATH)
    db.init()

    bus = ScanBus()
    scanner = LibraryScanner(db, config.MUSIC_DIR, bus)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        _bootstrap(db)
        watcher = LibraryWatcher(scanner, config.MUSIC_DIR)
        watcher.start()
        try:
            # First-run UX (Plex-like): an empty index next to a non-empty
            # folder means nobody has scanned yet — don't make them find
            # the Rescan button. Later restarts rely on the watcher.
            conn = db.connect()
            empty = conn.execute("SELECT COUNT(*) AS c FROM tracks").fetchone()["c"] == 0
            if empty and config.MUSIC_DIR.is_dir() and any(config.MUSIC_DIR.iterdir()):
                scanner.start_scan(trigger="startup")
            yield
        finally:
            watcher.stop()

    app = FastAPI(
        title="Flow",
        version="0.1.0",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        lifespan=lifespan,
    )
    app.state.db = db
    app.state.scan_bus = bus
    app.state.scanner = scanner

    @app.get("/api/health", tags=["system"])
    def health() -> dict:
        # Real liveness check: a broken database means an unhealthy container.
        db.connect().execute("SELECT 1").fetchone()
        return {"status": "ok", "version": app.version}

    app.include_router(scan_router.router)
    app.include_router(settings_router.router)
    app.include_router(library_router.router)
    app.include_router(covers_router.router)
    app.include_router(editing_router.router)
    app.include_router(playlists_router.router)
    app.include_router(search_router.router)
    app.include_router(media_router.router)
    app.include_router(queue_router.router)

    if config.DIST_DIR is not None and config.DIST_DIR.is_dir():
        _mount_spa(app, config.DIST_DIR)

    return app


def _mount_spa(app: FastAPI, dist: Path) -> None:
    """Serve the built frontend with SPA fallback.

    nginx does this in production (with gzip and sendfile); this keeps
    `uvicorn` alone usable for quick checks. Unknown /api/* paths must stay
    JSON 404s, not fall through to index.html.
    """
    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (dist / full_path).resolve() if full_path else dist
        if candidate.is_file() and dist in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(dist / "index.html")


app = create_app()
