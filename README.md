<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="Flow — an eighth note on a rounded tile" width="120">
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

## Features

- **Read-only by design** — metadata edits live in SQLite as overlays, never in your files' tags.
- **Built for big libraries** — windowed rendering and paged fetching: a 10,000-track library opens instantly and scrolls smoothly end to end.
- **Mass curation** — bulk re-grouping, inline cell edits, a "Needs attention" review strip, one-generation undo.
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

> **Keep it on the LAN.** Flow has no authentication by design; anyone who can reach the port can browse, stream, and rewrite your library's metadata. To listen from outside, tunnel in with a VPN (Cloudflare, WireGuard, Tailscale).

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

## License

Released under the [MIT License](LICENSE).
