"""Flow — FastAPI application factory (DESIGN.md §6, §7).

Milestone 1: application shell. Health endpoint, database bootstrap, and
static serving of the built frontend when FLOW_DIST_DIR is set. Library
routers land with Milestone 2.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import config
from app.db import Database


def create_app() -> FastAPI:
    app = FastAPI(
        title="Flow",
        version="0.1.0",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
    )

    db = Database(config.DB_PATH)
    db.init()
    app.state.db = db

    @app.get("/api/health", tags=["system"])
    def health() -> dict:
        # Real liveness check: a broken database means an unhealthy container.
        db.connect().execute("SELECT 1").fetchone()
        return {"status": "ok", "version": app.version}

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
