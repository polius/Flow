"""Flow — FastAPI application factory."""

from __future__ import annotations

import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app import artwork as artwork_core
from app import auth as auth_core
from app import config
from app import demo as demo_mode
from app import heal
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
from app.routers.common import TxRoute
from app.schemas import Health
from app.watcher import LibraryWatcher

logging.basicConfig(
    level=os.environ.get("FLOW_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("flow.main")


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
    # Login: FLOW_RESET_PASSWORD / FLOW_PASSWORD, then rewrite any v1.5.0
    # plain-token session keys as digests (signed-in browsers stay in).
    auth_core.apply_boot_env(conn, config.PASSWORD, config.RESET_PASSWORD)
    auth_core.upgrade_session_keys(conn)


def _prune_artwork_cache(db: Database) -> None:
    """Background: drop resized covers whose artwork is gone or changed."""
    cache_dir = config.DATA_DIR / artwork_core.THUMB_CACHE_DIR
    if not cache_dir.is_dir():
        return
    try:
        removed = artwork_core.prune_thumbnail_cache(db.connect(), cache_dir)
        if removed:
            log.info("Pruned %d stale resized covers", removed)
    except Exception:  # noqa: BLE001 - housekeeping must never stop the app
        log.warning("Artwork cache prune failed", exc_info=True)
    finally:
        db.close_thread()


# ---- cross-site write guard ---------------------------------------------------

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _split_host(value: str) -> tuple[str, int | None]:
    """'Host'-style value → (lowercased hostname, explicit port or None)."""
    parts = urlsplit(f"//{value.strip()}")
    try:
        port = parts.port
    except ValueError:
        port = None
    return (parts.hostname or "").lower(), port


def _origin_matches_host(origin: str, hosts: list[str]) -> bool:
    """Does the browser's Origin name one of the hosts this request was
    addressed to? A Host without a port (nginx forwards `$host`, which drops
    it) matches the origin on any port; an explicit port must agree."""
    parts = urlsplit(origin)
    if parts.scheme not in _DEFAULT_PORTS or not parts.hostname:
        return False  # "null" (sandboxed frame, file://) or junk
    try:
        origin_port = parts.port or _DEFAULT_PORTS[parts.scheme]
    except ValueError:
        return False
    for value in hosts:
        name, port = _split_host(value)
        if name == parts.hostname.lower() and port in (None, origin_port):
            return True
    return False


def cross_site_write(request: Request) -> bool:
    """True for a state-changing /api request a browser sent on behalf of
    another site. Requests without browser provenance headers (curl,
    scripts, the healthcheck) pass: this guards browsers, not clients."""
    if request.method in _SAFE_METHODS or not request.url.path.startswith("/api/"):
        return False
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    if fetch_site == "cross-site":
        return True
    if fetch_site in ("same-origin", "none"):
        # The browser itself vouches for the origin — no Host comparison, so
        # a reverse proxy that rewrites Host can't break the app's writes.
        return False
    # Older browsers (no Sec-Fetch-Site) and same-site requests (a sibling
    # subdomain or another port on the same host): compare Origin to Host.
    origin = request.headers.get("origin")
    if origin is None:
        return False
    # Behind a reverse proxy the public name may only survive in
    # X-Forwarded-Host (a browser can't set it cross-site without a CORS
    # preflight, which this API never grants).
    hosts = [request.headers.get("host", "")]
    forwarded = request.headers.get("x-forwarded-host")
    if forwarded:
        hosts += [h for h in forwarded.split(",") if h.strip()]
    return not _origin_matches_host(origin, hosts)


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
        # One-time library heal (idempotent, cheap when there's nothing to
        # do); before the watcher, so its changes don't read as file events.
        try:
            heal.run_startup_heal(db)
        except Exception:  # noqa: BLE001 - a heal must never block startup
            log.exception("Startup heal failed")
        threading.Thread(
            target=_prune_artwork_cache, args=(db,), name="flow-artwork-cache", daemon=True
        ).start()
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
    # Every route rolls back its thread's open transaction when it ends
    # (see TxRoute); the routers declare it too.
    app.router.route_class = TxRoute
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
    # the login page when the answer is "enabled, not signed in". The check
    # is answered from memory (auth.request_allowed), so the event loop
    # doesn't wait on SQLite for every request.
    _AUTH_PUBLIC_PATHS = {"/api/health", "/api/auth/status", "/api/auth/login"}

    @app.middleware("http")
    async def auth_gate(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/") and path not in _AUTH_PUBLIC_PATHS:
            token = request.cookies.get(auth_core.SESSION_COOKIE)
            if not auth_core.request_allowed(request.app.state.db, token):
                return JSONResponse({"detail": "Not authenticated"}, status_code=401)
        return await call_next(request)

    # Outermost: a cross-site page must not be able to trigger writes (scan,
    # undo, edits) — with login off there is no cookie to stop it.
    @app.middleware("http")
    async def same_origin_writes(request: Request, call_next):
        if cross_site_write(request):
            return JSONResponse(
                {"detail": "Cross-site request refused"}, status_code=403
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
