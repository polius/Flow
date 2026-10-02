<div align="center">
<img src="frontend/public/icons/icon-512.png" alt="Flow Logo" width="80">
<h1 align="center">Flow</h1>

**Stream your own music collection — point it at a folder and it scans, indexes, and plays. Self-hosted, Dockerized, and it never writes to your files.**

<p align="center">
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
</p>

<br>

</div>

## Features

- **Read-only by design**: Flow never modifies a single file of yours — scanning, playback, and editing only read. Metadata edits live in SQLite as overlays, not in your files' tags.
- **Built for big libraries**: the Tracks view and the queue drawer render only the visible window of rows and fetch pages as you scroll, so a 10,000-track library opens instantly and scrolls smoothly end to end.
- **Mass metadata curation**: the Organize view gives you bulk re-grouping, inline cell edits, a "Needs attention" review strip, and one-generation undo.
- **Forgiving scanner**: corrupt or unreadable files are skipped and logged, never crash a scan. A scan that finds zero files against a non-empty index is treated as a broken mount, not a library cleanup.
- **Efficient streaming**: audio is served straight from disk with native `Range` support, so seeking is instant and nothing is buffered through the app.
- **One small image**: base OS, nginx, backend, and the built frontend in a single ~99MB Docker container.
- **No accounts**: there is no authentication by design; Flow is meant for your LAN, reached over VPN from outside.

## Self-hosting

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

### Setup

1. Download [`docker-compose.yml`](docker-compose.yml).
2. Create a `flow` folder next to it and put your music in a `music` subfolder (`flow/music/*.mp3`, …).
3. Start it:

```bash
docker compose up -d
```

Open `http://localhost:8080` — API docs live at `/api/docs`.

An empty index next to a non-empty music folder triggers a scan automatically on startup; after that the watcher picks up changes, and the Rescan button in Settings forces a pass.

> **Keep it on the LAN.** Do not port-forward Flow or expose it to the public internet — there is no authentication, so anyone who can reach the port can browse, stream, and rewrite your library's metadata. To listen from outside your network, tunnel in with a VPN (WireGuard, Tailscale).

### Building from source (optional)

```bash
git clone https://github.com/polius/Flow.git
cd Flow
docker build -t poliuscorp/flow:latest .
docker compose up -d
```

## Required ports

Open this on your server's firewall:

| Port | Protocol | Purpose |
|---|---|---|
| `8080` | TCP | Web interface, API, and audio streaming |

The port is published on all interfaces — LAN access is intended.

## Configuration

No configuration needed. Everything Flow touches lives in one host folder, mounted at `/flow` inside the container:

| Host path | Container path | Contents |
|---|---|---|
| `./flow/music` | `/flow/music` | Your audio files — read as-is, never written to |
| `./flow/data` | `/flow/data` | SQLite index (created automatically on first start) |

**Upgrading from an earlier release?** Move your existing folders into place:

```bash
mkdir flow && mv music flow/music && mv data flow/data
```

**Custom port.** Change the **first** number of the port mapping; the second is the container's internal port, leave it as `8080`:

```yaml
ports:
  - "8888:8080"   # serve on http://localhost:8888
```

## How it works

Point Flow at a folder and it scans every audio file it can parse into a SQLite index — tags, artwork, and structure. A filesystem watcher keeps the index in sync as files appear or disappear. Your music files are never written to: every metadata edit is an overlay row in SQLite applied at read time, so your files' tags are never rewritten. Removed files delete their rows (playlists cascade), and a scan that finds **zero** files against a non-empty index refuses to delete anything — that pattern means a broken mount, not a library cleanup. To reset a library, delete the `flow/data` folder.

Audio is streamed, not proxied through the application: FastAPI answers a track request with an internal X-Accel-Redirect and nginx serves the bytes straight from disk with native `Range` support, which is what makes seeking instant.

The frontend is a React SPA served by the same container — one image, one port. The full product and engineering contract (scope, API shape, design system, recorded decisions) lives in [`docs/DESIGN.md`](docs/DESIGN.md).

## Development

Backend:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
FLOW_MUSIC_DIR=$PWD/../music FLOW_DATA_DIR=$PWD/.data .venv/bin/uvicorn app.main:app --reload
```

Frontend (second terminal):

```bash
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `127.0.0.1:8000`, so no CORS is involved. If 5173/5174 are taken, Vite auto-increments the port — open whichever URL it prints.

Tests are hermetic; no real audio files needed:

```bash
cd backend && .venv/bin/python -m pytest tests/ -q
```

The frontend TypeScript client is generated from the OpenAPI schema — do not hand-write API types. With the backend running:

```bash
cd frontend && npm run gen:api
```

Commit the regenerated `src/api/schema.d.ts` whenever the API changes.

For visual work against a realistic library (with renderable cover art), generate a scratch one:

```bash
cd backend && .venv/bin/python scripts/dev_library.py --out /tmp/flow-music --tracks 10000
FLOW_MUSIC_DIR=/tmp/flow-music FLOW_DATA_DIR=/tmp/flow-data .venv/bin/uvicorn app.main:app --port 8000
```

Artwork responses are `Cache-Control: immutable`, so use a fresh browser context (or hard-reload) when pointing the same dev port at a different data dir.

## Related projects

Need to get files onto the machine running Flow? Check out [FileSync](https://github.com/polius/FileSync) — send files from one device to many, in real time, private and peer-to-peer.

## License

Released under the [MIT License](LICENSE).
