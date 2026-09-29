# Flow

Self-hosted, Dockerized music player for your own files. Plex model: point it
at a folder, it scans, indexes, and streams — and **never writes to your music
folder**. Metadata edits live in SQLite as overlays.

`docs/DESIGN.md` is the product and engineering contract: scope, API shape,
design system, milestones, and non-goals. Read it before adding anything.

**Status:** Milestone 5 — Now Playing + polish. Full-screen Now Playing with
blurred-artwork ambience (album detail too) and a removable queue drawer,
global keyboard shortcuts (documented in Settings), light/dark/auto theme
override, designed loading/empty states, and Media Session integration.

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

Vite proxies `/api` to `127.0.0.1:8000`, so no CORS is involved.

Tests (hermetic; no real audio files needed):

```sh
cd backend && .venv/bin/python -m pytest tests/ -q
```

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
| `FLOW_LOG_LEVEL` | `INFO` | `docker logs` verbosity |

## Layout

See DESIGN.md §7 for the contract, §13–14 for recorded decisions. Notable:
removed files delete their rows (playlists cascade), but a scan that finds
**zero** files against a non-empty index refuses to delete anything — that
pattern means a broken mount, not a library cleanup. To reset a library,
remove the `flow-data` volume.
