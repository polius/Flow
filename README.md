<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo-light.svg" alt="Flow — an eighth note on a rounded tile" width="120">
</picture>

<h1>Flow</h1>

<p>
  <strong>Point it at a folder of music. It scans, indexes, and streams — self-hosted,<br>
  one small Docker container, and it never writes to your files.</strong>
</p>

<p>
  <a href="https://github.com/polius/Flow/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/polius/Flow/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
</p>

</div>

## Why Flow

- **Read-only by design** — metadata edits live in SQLite as overlays, never in your files' tags.
- **Built for big libraries** — windowed rendering and paged fetching: a 10,000-track library opens instantly and scrolls smoothly end to end.
- **Mass curation** — bulk re-grouping, inline cell edits, a "Needs attention" review strip, one-generation undo.
- **Forgiving scanner** — corrupt files are skipped and logged; a scan that finds zero files against a non-empty index is a broken mount, not a cleanup.
- **Instant seeking** — audio streams straight from disk with native `Range` support, not proxied through the app.
- **One small image** — ~99 MB with base OS, nginx, backend, and the built frontend. No accounts, LAN + VPN by design.

## Quick start

Requires [Docker](https://docs.docker.com/get-docker/) with [Compose](https://docs.docker.com/compose/install/).

1. Download [`docker-compose.yml`](docker-compose.yml).
2. Create a `flow` folder next to it and put your music in `flow/music/`.
3. Start:

```bash
docker compose up -d
```

Open `http://localhost:8080` — API docs live at `/api/docs`.

> **Keep it on the LAN.** Flow has no authentication by design; anyone who can reach the port can browse, stream, and rewrite your library's metadata. To listen from outside, tunnel in with a VPN (WireGuard, Tailscale).

An empty index next to a non-empty music folder triggers a scan on startup; after that the watcher keeps the index in sync, and Settings has a Rescan button.

## Configuration

Everything Flow touches lives in one host folder, mounted at `/flow` inside the container:

| Host path | Container path | Contents |
|---|---|---|
| `./flow/music` | `/flow/music` | Your audio files — read as-is, never written to |
| `./flow/data` | `/flow/data` | SQLite index (created on first start) |

**Custom port** — change the *first* number of the mapping; leave the container port as `8080`:

```yaml
ports:
  - "8888:8080"
```

**Upgrading from an earlier release** — move your folders into place:

```bash
mkdir flow && mv music flow/music && mv data flow/data
```

## How it works

Flow scans every audio file it can parse into a SQLite index — tags, artwork, structure — and a filesystem watcher keeps the index in sync as files appear or disappear. Metadata edits are overlay rows applied at read time, so your files are never rewritten. Removed files delete their rows (playlists cascade), and a zero-file scan against a non-empty index refuses to delete anything — that pattern means a broken mount, not a library cleanup. To reset, delete `flow/data`.

Audio is streamed, not proxied: FastAPI answers with an internal `X-Accel-Redirect` and nginx serves the bytes straight from disk with native `Range` support — which is what makes seeking instant. The frontend is a React SPA served by the same container: one image, one port. The full product and engineering contract lives in [`docs/DESIGN.md`](docs/DESIGN.md).

## Development

Backend:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
FLOW_MUSIC_DIR=$PWD/../music FLOW_DATA_DIR=$PWD/.data .venv/bin/uvicorn app.main:app --reload
```

Frontend (second terminal — Vite proxies `/api` to `127.0.0.1:8000`, no CORS):

```bash
cd frontend
npm install
npm run dev
```

Tests are hermetic; no real audio files needed:

```bash
cd backend && .venv/bin/python -m pytest tests/ -q   # backend
cd frontend && npm test                              # frontend
cd frontend && npm run lint                          # ESLint (type-aware)
```

The frontend TypeScript client is generated from the OpenAPI schema — never hand-written:

```bash
cd frontend && npm run gen:api
```

Commit the regenerated `src/api/schema.d.ts` whenever the API changes.

For visual work against a realistic library (with renderable cover art):

```bash
cd backend && .venv/bin/python scripts/dev_library.py --out /tmp/flow-music --tracks 10000
FLOW_MUSIC_DIR=/tmp/flow-music FLOW_DATA_DIR=/tmp/flow-data .venv/bin/uvicorn app.main:app --port 8000
```

Artwork responses are `Cache-Control: immutable`, so hard-reload when pointing the same dev port at a different data dir.

## Related projects

Need to get files onto the machine running Flow? Check out [FileSync](https://github.com/polius/FileSync) — send files from one device to many, in real time, private and peer-to-peer.

## License

Released under the [MIT License](LICENSE).
