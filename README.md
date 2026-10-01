# Flow

Self-hosted, Dockerized music player for your own files. Plex model: point it
at a folder, it scans, indexes, and streams — and **never writes to your music
folder**. Metadata edits live in SQLite as overlays.

`docs/DESIGN.md` is the product and engineering contract: scope, API shape,
design system, milestones, and non-goals. Read it before adding anything.

**Status:** Milestone 6 — hardening (final milestone). The library is built
for 10k+ tracks: the Tracks view and the queue drawer are windowed
(`@tanstack/react-virtual`), the scanner skips and logs corrupt or unreadable
files instead of crashing, and the image stays inside the ~150–200MB budget
(see [Docker image size](#docker-image-size)). Milestones 1–5 cover scan,
browsing + playback, playlists + editing, and the Now Playing polish pass.

Post-M6 addition: the **Organize** view (`/organize`) — mass curation of the
library's metadata over the same SQLite overlays (bulk re-grouping, inline
cell edits, a "Needs attention" review strip, one-generation undo). Files are
never written (DESIGN.md §22).

## Quick start (Docker)

```sh
mkdir music            # or point FLOW_MUSIC at an existing folder
docker compose up --build
```

→ http://localhost:8080 — OpenAPI docs at `/api/docs`.

The music folder is mounted read-only. An empty index next to a non-empty
library folder triggers a scan automatically on startup; after that, the
watcher picks up changes and the Rescan button in Settings forces a pass.
The port is published on all interfaces (LAN access intended; there is no
auth by design).

> **Keep it on the LAN.** Do not port-forward Flow or expose it to the
> public internet — there is no authentication, so anyone who can reach the
> port can browse, stream, and rewrite your library's metadata. To listen
> from outside your network, tunnel in with a VPN (WireGuard, Tailscale).

## Quick start (dev)

Backend:

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
FLOW_MUSIC_DIR=$PWD/../music FLOW_DATA_DIR=$PWD/.data .venv/bin/uvicorn app.main:app --reload
```

Frontend (second terminal):

```sh
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `127.0.0.1:8000`, so no CORS is involved. If 5173/5174
are taken, Vite auto-increments the port — open whichever URL it prints.

Tests (hermetic; no real audio files needed):

```sh
cd backend && .venv/bin/python -m pytest tests/ -q
```

### Scratch library for visual work

`./music` is usually empty; generate a realistic one (includes real renderable
PNG covers — fixture art bytes don't render in `<img>`):

```sh
cd backend && .venv/bin/python scripts/dev_library.py --out /tmp/flow-music --tracks 10000
FLOW_MUSIC_DIR=/tmp/flow-music FLOW_DATA_DIR=/tmp/flow-data .venv/bin/uvicorn app.main:app --port 8000
```

The scan starts on boot; artwork responses are `Cache-Control: immutable`, so
use a fresh browser context (or hard-reload) when pointing the same dev port
at a different data dir.

## Generated API client

The frontend TypeScript client is generated from the OpenAPI schema — do not
hand-write API types (DESIGN.md §6). With the backend running:

```sh
cd frontend && npm run gen:api
```

Commit the regenerated `src/api/schema.d.ts` whenever the API changes.

## Configuration

| Env var | Container default | Meaning |
|---|---|---|
| `FLOW_MUSIC_DIR` | `/music` | Library root, mounted read-only |
| `FLOW_DATA_DIR` | `/data` | SQLite database location |
| `FLOW_DIST_DIR` | `/app/static` | Built frontend served by uvicorn (nginx does the same in front) |
| `FLOW_STREAM_MODE` | `nginx` in Docker, `direct` in dev | `nginx` = X-Accel-Redirect into the internal music location (native sendfile/Range); `direct` = FastAPI streams with Range |
| `FLOW_WATCHER` | `auto` | `auto` (polling in Docker, native elsewhere), `native`, or `polling` |
| `FLOW_POLL_INTERVAL` | `5` | Polling observer interval (seconds), Docker only |
| `FLOW_WATCH_DEBOUNCE` | `2` | Debounce window before a watch-triggered rescan |
| `FLOW_LOG_LEVEL` | `INFO` | uvicorn/app log verbosity (`docker logs`) |

## Large libraries

The scanner indexes ~10k files in well under a minute and skips anything it
cannot parse — truncated, zero-byte, or mis-labeled files are logged with an
error count in Settings, never crash a scan, and never block removals of
deleted tracks. A scan that finds **zero** files against a non-empty index is
treated as a broken mount instead (see below).

The Tracks view and the queue drawer render only the visible window of rows;
data is fetched in pages of 1,000 as you scroll, so a 10k-track library opens
instantly and scrolls smoothly end to end. Album, artist, and playlist views
render their (unpaginated) detail payloads directly — they don't hit this
scale in practice.

## Docker image size

Final image (`flow:latest`): **~99MB** by `docker image ls` (~23MB
compressed transfer). Composition: python:3.13-alpine base + nginx + tini +
a ~19MB venv + the built frontend. The build strips tests, `__pycache__`,
and `.pyc`; pip is uninstalled from the runtime venv.

The base is Alpine by owner decision (2026-09-29), superseding the original
Debian-slim choice in DESIGN.md §10.4: the slim-based image measured 235MB —
over the §10 ~150–200MB budget — with the slim base alone at ~202MB. Every
runtime dependency ships a musl wheel, so the image needs no compiler.
Verified after the switch: 10k-file scan, nginx-mode Range streaming,
immutable artwork caching, and graceful tini shutdown.

## Layout

See DESIGN.md §7 for the contract, §13–17 for recorded decisions. Notable:
removed files delete their rows (playlists cascade), but a scan that finds
**zero** files against a non-empty index refuses to delete anything — that
pattern means a broken mount, not a library cleanup. To reset a library,
remove the `flow-data` volume.
