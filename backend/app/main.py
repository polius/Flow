"""Flow — FastAPI application factory."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app import auth as auth_core
from app import config
from app import demo as demo_mode
from app.db import Database
from app.events import ScanBus
from app.scanner import LibraryScanner
from app.routers import auth as auth_router
from app.routers import editing as editing_router
from app.routers import covers as covers_router
from app.routers import library as library_router
from app.routers import media as media_router
from app.routers import playlists as playlists_router
from app.routers import queue as queue_router
from app.routers import scan as scan_router
from app.routers import search as search_router
from app.routers import settings as settings_router
from app.schemas import Health
from app.watcher import LibraryWatcher

logging.basicConfig(
    level=os.environ.get("FLOW_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


def _bootstrap(db: Database) -> None:
    """Startup-time settings hygiene."""
    # First-run turnkey: the music folder must exist before the watcher or
    # the auto-scan look at it. exist_ok makes this a no-op when it's there
    # — an existing library is never touched, let alone recreated.
    config.MUSIC_DIR.mkdir(parents=True, exist_ok=True)
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
        # Demo first boot writes its library before the watcher exists, so
        # generation doesn't trip watcher-triggered scans on the way in.
        demo_tracks = demo_mode.prepare_library(db) if config.DEMO else None
        watcher = LibraryWatcher(scanner, config.MUSIC_DIR)
        watcher.start()
        try:
            # First-run UX (Plex-like): an empty index next to a non-empty
            # folder means nobody has scanned yet — don't make them find
            # the Rescan button. Later restarts rely on the watcher.
            conn = db.connect()
            empty = conn.execute("SELECT COUNT(*) AS c FROM tracks").fetchone()["c"] == 0
            if demo_tracks is not None:
                # Scan the freshly generated files and dress the DB before
                # serving, so the demo's first paint is never empty.
                scanner.start_scan(trigger="demo")
                demo_mode.seed_when_indexed(db, demo_tracks)
            elif empty and config.MUSIC_DIR.is_dir() and any(config.MUSIC_DIR.iterdir()):
                scanner.start_scan(trigger="startup")
            yield
        finally:
            watcher.stop()

    app = FastAPI(
        title="Flow",
        version=__version__,
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        lifespan=lifespan,
    )
    app.state.db = db
    app.state.scan_bus = bus
    app.state.scanner = scanner

    @app.get("/api/health", tags=["system"], response_model=Health)
    def health() -> Health:
        # Real liveness check: a broken database means an unhealthy container.
        # Typed so `version` is part of the OpenAPI contract the frontend
        # generates its client from — the topbar badge reads it from here.
        db.connect().execute("SELECT 1").fetchone()
        return Health(status="ok", version=app.version)

    # ---- the login gate ------------------------------------------------------
    # When no password is set (auth off) this is a pass-through. When one is,
    # every /api/* path needs a valid session cookie — except /api/health,
    # which the container healthcheck polls without one, and the auth
    # endpoints themselves, which are how a session is earned. Static files
    # stay open: the SPA loads, asks /api/auth/status, and routes itself to
    # the login page when the answer is "enabled, not signed in".
    _AUTH_PUBLIC_PATHS = {"/api/health", "/api/auth/status", "/api/auth/login"}

    @app.middleware("http")
    async def auth_gate(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/") and path not in _AUTH_PUBLIC_PATHS:
            conn = request.app.state.db.connect()
            if auth_core.get_password_hash(conn) is not None:
                token = request.cookies.get(auth_core.SESSION_COOKIE)
                if not auth_core.validate_session(conn, token):
                    return JSONResponse(
                        {"detail": "Not authenticated"}, status_code=401
                    )
        return await call_next(request)

    app.include_router(auth_router.router)
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

    nginx does this in production; this keeps bare `uvicorn` usable. Unknown
    /api/* paths must stay JSON 404s, never fall through to index.html.
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
