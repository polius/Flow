"""The scan progress stream lives on the event loop: open streams cost no
worker thread, so many tabs can't starve every other endpoint. Run against
a real uvicorn server — the TestClient can't hold streams open concurrently.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time

import httpx
import pytest
import uvicorn

STREAMS = 50  # above Starlette's 40-thread pool, where the sync stream froze the API


@pytest.fixture
def server(request, tmp_path, monkeypatch, music):
    from app import config
    from app.main import create_app
    from app.routers import scan as scan_router

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "sse.db")
    monkeypatch.setattr(config, "MUSIC_DIR", music)
    monkeypatch.setattr(config, "DIST_DIR", None)
    monkeypatch.setattr(scan_router, "KEEPALIVE_SECONDS", getattr(request, "param", 15.0))
    app = create_app()
    monkeypatch.setattr(app.state.scanner, "start_scan", lambda trigger, full=False: False)

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=port, log_level="warning",
            timeout_graceful_shutdown=1,
        )
    )
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not srv.started:
        assert time.monotonic() < deadline, "server did not start"
        time.sleep(0.02)
    yield app, f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)
    app.state.db.close_all()


async def _first_event(client: httpx.AsyncClient, url: str, opened: asyncio.Event,
                       release: asyncio.Event, counter: list) -> None:
    async with client.stream("GET", f"{url}/api/scan") as response:
        lines = response.aiter_lines()
        line = await lines.__anext__()
        assert line.startswith("data: ")
        counter.append(1)
        if len(counter) == STREAMS:
            opened.set()
        await release.wait()


def test_many_open_streams_do_not_starve_the_api(server):
    _app, url = server

    async def scenario():
        opened, release, counter = asyncio.Event(), asyncio.Event(), []
        limits = httpx.Limits(max_connections=STREAMS + 10)
        async with httpx.AsyncClient(timeout=10, limits=limits) as client:
            tasks = [
                asyncio.create_task(_first_event(client, url, opened, release, counter))
                for _ in range(STREAMS)
            ]
            await asyncio.wait_for(opened.wait(), 10)
            # Every stream is open and parked; ordinary endpoints answer.
            async with httpx.AsyncClient(timeout=5) as other:
                started = time.monotonic()
                for path in ("/api/settings", "/api/health", "/api/queue"):
                    assert (await other.get(f"{url}{path}")).status_code == 200
                assert time.monotonic() - started < 3
            release.set()
            await asyncio.gather(*tasks)

    asyncio.run(scenario())


@pytest.mark.parametrize("server", [0.3], indirect=True)
def test_stream_sends_snapshot_events_and_keepalives(server):
    app, url = server

    async def scenario():
        async with httpx.AsyncClient(timeout=10) as client:
            async with client.stream("GET", f"{url}/api/scan") as response:
                assert response.headers["content-type"].startswith("text/event-stream")
                lines = response.aiter_lines()
                first = json.loads((await lines.__anext__())[len("data: "):])
                assert first["type"] == "state" and first["state"] == "idle"

                # A burst from the scanner thread: the stream delivers the
                # latest state (stale intermediate ones may be skipped).
                def burst():
                    for i in range(1, 101):
                        app.state.scan_bus.publish(
                            {"type": "state", "state": "scanning", "current": i}
                        )

                await asyncio.to_thread(burst)
                seen = []
                while not seen or seen[-1].get("current") != 100:
                    line = await lines.__anext__()
                    if line.startswith("data: "):
                        seen.append(json.loads(line[len("data: "):]))
                assert len(seen) <= 100

                # Quiet stream: comment keepalives (patched to 0.3 s).
                while True:
                    line = await lines.__anext__()
                    if line.startswith(":"):
                        assert line == ": keepalive"
                        break

    asyncio.run(scenario())
    # The closed stream unsubscribed.
    deadline = time.monotonic() + 3
    while app.state.scan_bus._subs and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not app.state.scan_bus._subs
