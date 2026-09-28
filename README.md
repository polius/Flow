# Flow

Self-hosted, Dockerized music player for your own files. Plex model: point it
at a folder, it scans, indexes, and streams — and **never writes to your music
folder**. Metadata edits live in SQLite as overlays.

`docs/DESIGN.md` is the product and engineering contract: scope, API shape,
design system, milestones, and non-goals. Read it before adding anything.

**Status:** Milestone 1 — skeleton. Dockerized app shell, `/api/health`,
SQLite migrations, empty React shell with sidebar + player bar.

## Quick start (Docker)

```sh
mkdir music            # or point FLOW_MUSIC at an existing folder
docker compose up --build
```

→ http://localhost:8080 — OpenAPI docs at `/api/docs`.

The music folder is mounted read-only. Bind the port to localhost only if you
do not want LAN access (there is no auth by design).

## Quick start (dev)

Backend:

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
FLOW_MUSIC_DIR=$PWD/../music FLOW_DATA_DIR=$PWD/.data .venv/bin/uvicorn app.main:app --reload
```

Frontend (second terminal):

```sh
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `127.0.0.1:8000`, so no CORS is involved.

## Configuration

| Env var | Container default | Meaning |
|---|---|---|
| `FLOW_MUSIC_DIR` | `/music` | Library root, mounted read-only |
| `FLOW_DATA_DIR` | `/data` | SQLite database location |
| `FLOW_DIST_DIR` | `/app/static` | Built frontend served by uvicorn (nginx does the same in front) |

## Layout

See DESIGN.md §7. Frontend dev backend + `vite dev` (proxied) is the primary
DX; the Docker image is the deployment artifact, not the dev environment.
