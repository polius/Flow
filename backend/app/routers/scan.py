"""Scan endpoints: SSE progress stream + manual trigger."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.events import ScanBus
from app.routers.common import TxRoute
from app.schemas import ScanErrorEntry, ScanErrorLog
from app.scanner import LibraryScanner

router = APIRouter(tags=["scan"], route_class=TxRoute)

KEEPALIVE_SECONDS = 15.0


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n"


@router.get("/api/scan", summary="Scan progress event stream (SSE)")
async def scan_events(request: Request) -> StreamingResponse:
    """Every app tab holds one of these open, so the stream lives on the
    event loop and costs no worker thread while it waits — a sync generator
    parked in a blocking get() held one of the shared pool's 40 threads per
    tab, and enough tabs froze every endpoint, the healthcheck included."""
    bus: ScanBus = request.app.state.scan_bus
    scanner: LibraryScanner = request.app.state.scanner

    async def event_stream() -> AsyncIterator[str]:
        # Subscribed inside the generator so a client gone before the first
        # byte never leaves a subscription behind.
        sub = bus.subscribe(asyncio.get_running_loop())
        try:
            # Snapshot first, so a page reload shows current state instantly
            # (a settings read — off the loop).
            yield _sse(await run_in_threadpool(scanner.current_state_event))
            while True:
                event = await sub.get(KEEPALIVE_SECONDS)
                # Comment line keeps proxies from idling out the stream.
                yield _sse(event) if event is not None else ": keepalive\n\n"
        finally:
            bus.unsubscribe(sub)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/api/scan/errors", response_model=ScanErrorLog, tags=["scan"])
def scan_error_log(request: Request) -> ScanErrorLog:
    """Skipped files from the last scan — path + reason."""
    scanner: LibraryScanner = request.app.state.scanner
    log_dict = scanner.scan_error_log()
    return ScanErrorLog(
        total=log_dict["total"],
        truncated=log_dict["truncated"],
        items=[ScanErrorEntry(**item) for item in log_dict["items"]],
    )


@router.post(
    "/api/scan",
    summary="Trigger a library rescan",
    status_code=202,
)
def trigger_scan(
    request: Request,
    full: bool = Query(
        False,
        description="Re-read every file's tags, not just the ones whose "
        "size or mtime changed (for taggers that preserve timestamps).",
    ),
) -> dict:
    scanner: LibraryScanner = request.app.state.scanner
    if not scanner.start_scan(trigger="manual", full=full):
        raise HTTPException(status_code=409, detail="Scan already running")
    return {"state": "scanning"}
