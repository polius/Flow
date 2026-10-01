"""Scan endpoints: SSE progress stream + manual trigger (DESIGN.md §6, §9.6)."""

from __future__ import annotations

import json
import queue
from collections.abc import Iterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.events import ScanBus
from app.schemas import ScanErrorEntry, ScanErrorLog
from app.scanner import LibraryScanner

router = APIRouter(tags=["scan"])

KEEPALIVE_SECONDS = 15.0


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n"


@router.get("/api/scan", summary="Scan progress event stream (SSE)")
def scan_events(request: Request) -> StreamingResponse:
    bus: ScanBus = request.app.state.scan_bus
    scanner: LibraryScanner = request.app.state.scanner

    def event_stream() -> Iterator[str]:
        q = bus.subscribe()
        try:
            # Snapshot first, so a page reload shows current state instantly.
            yield _sse(scanner.current_state_event())
            while True:
                try:
                    event = q.get(timeout=KEEPALIVE_SECONDS)
                    yield _sse(event)
                except queue.Empty:
                    # Comment line keeps proxies from idling out the stream.
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/api/scan/errors", response_model=ScanErrorLog, tags=["scan"])
def scan_error_log(request: Request) -> ScanErrorLog:
    """Skipped files from the last scan — path + reason (§2.8). Settings
    fetches this lazily when its disclosure opens."""
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
def trigger_scan(request: Request) -> dict:
    scanner: LibraryScanner = request.app.state.scanner
    if not scanner.start_scan(trigger="manual"):
        raise HTTPException(status_code=409, detail="Scan already running")
    return {"state": "scanning"}
