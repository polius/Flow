<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="Flow — an eighth note on a rounded tile" width="120">
</picture>

<h1>Flow</h1>

<p>
  <strong>Your music, streamed from your own server.</strong><br>
</p>

<p>
  <a href="https://github.com/polius/Flow/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/polius/Flow/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/polius/Flow/actions/workflows/release.yml"><img alt="Release" src="https://github.com/polius/Flow/actions/workflows/release.yml/badge.svg"></a>
  <a href="https://github.com/polius/Flow/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/polius/Flow"></a>
  <a href="https://hub.docker.com/r/poliuscorp/flow"><img alt="Docker Pulls" src="https://img.shields.io/docker/pulls/poliuscorp/flow"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
</p>


<img src="assets/albums.png" alt="Flow album view" width="100%">

</div>

## Quick demo

Want to try it out? Run:

```bash
docker run --rm -e DEMO=true -p 8080:8080 poliuscorp/flow
```

Then open http://localhost:8080 in your browser.

> **The demo tracks are silent.** They're generated placeholder files, not real music. Everything else works exactly as it does with your own files.

## Set up

1. Download [`docker-compose.yml`](docker-compose.yml).

2. Start the container:

   ```bash
   docker compose up -d
   ```

On first start, a `flow/` folder is created next to the compose file, with a `music/` subfolder where you can add your music files.

> Root-owned host folders (common on NAS) work as-is: the container prepares its data folder on start and then runs unprivileged — no manual `chown` needed.
>
> The app runs as uid/gid `1000:1000`. If your music belongs to another user (Synology is often `1026:100`, Unraid `99:100`), set `PUID` and `PGID` to match. If the music folder isn't readable, the log says so on start.

## Adding music

Copy your audio files (`MP3`, `FLAC`, `M4A`, or `OGG`) anywhere inside `flow/music/`.

Any folder structure works. Files can be organized into artist and album folders, kept in a single directory, or placed directly in the root:

```text
flow/
└── music/
    ├── My Mixtape.mp3
    ├── Artist Name/
    │   └── Album Name/
    │       └── 01 - Song.mp3
    └── Some Other Song.flac
```

**Albums and artists are read from your files' tags, not their folder names.**

Untagged files are still indexed. For example, a file named `01 - Song.mp3` is interpreted as track 1 with the title `Song`; otherwise, the filename is used as the title.

For the best experience — including albums, artwork, and artist pages — make sure your files have proper metadata.

New files are picked up automatically. You can also trigger a scan at any time from **Settings → Library**.

To remove music, delete the files and run a scan.

### Browser support

Flow streams your files as they are; it doesn't transcode. What plays depends on the browser:

| Format | Chrome, Edge, Firefox | Safari (macOS, iOS) |
| --- | --- | --- |
| MP3, FLAC, M4A (AAC) | ✓ | ✓ |
| M4A (ALAC, Apple Lossless) | ✗ | ✓ |
| OGG (Vorbis, Opus) | ✓ | Recent versions only |

Other formats, such as AIFF and WAV, aren't indexed. Convert ALAC and AIFF to FLAC to play them everywhere.

## Password

**Flow has no password by default.** Anyone who can reach the port can use it, including changing settings and editing tags. Set a password in **Settings → Access**, or with the `FLOW_PASSWORD` environment variable. It's only applied on start when no password is set yet, and it never overwrites one you've set in the app.

Forgot it? Start the container once with `FLOW_RESET_PASSWORD=1`. That removes the password and signs out every session; if `FLOW_PASSWORD` is also set, it becomes the new password. Then remove the variable, or every restart resets the password again.

## HTTPS and reverse proxies

To use Flow outside your home network, put it behind a reverse proxy that handles HTTPS. Then publish the port on localhost only (`"127.0.0.1:8080:8080"` in `docker-compose.yml`). The proxy needs to:

- **Not buffer responses**, so live scan progress (server-sent events) arrives as it happens.
- **Accept uploads of at least 12 MB**, for cover images.
- **Send `X-Forwarded-For` and `X-Forwarded-Proto`.** The session cookie is marked `Secure` when the proxy reports HTTPS.

Set `FLOW_TRUSTED_PROXIES` to the proxy's address. Then Flow's login rate limit applies to each client rather than to the proxy as a whole. Without it, one person guessing passwords can lock everyone out for a minute.

**Caddy**

```caddy
music.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
    }
}
```

**nginx**

```nginx
server {
    listen 443 ssl;
    server_name music.example.com;
    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

**Traefik** (labels on the `flow` service; Traefik streams and accepts large bodies by default)

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.flow.rule=Host(`music.example.com`)
      - traefik.http.routers.flow.entrypoints=websecure
      - traefik.http.routers.flow.tls.certresolver=letsencrypt
      - traefik.http.services.flow.loadbalancer.server.port=8080
    environment:
      FLOW_TRUSTED_PROXIES: "172.16.0.0/12"  # the Docker network Traefik connects from
```

## Backups

Everything Flow creates lives in `flow/data/`: the database (`flow.db`, plus `flow.db-wal` and `flow.db-shm` while it runs) and repaired copies of damaged files. Your music folder is never modified.

The database is written continuously, so don't copy it while Flow is running. Either stop the container first:

```bash
docker compose stop && cp -a flow/data flow-data-backup && docker compose start
```

or take a consistent copy while it runs:

```bash
sqlite3 flow/data/flow.db "VACUUM INTO 'flow-backup.db'"
```

Before a new version upgrades the database, Flow also saves a copy of it in `flow/data/` automatically.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Images are tagged by version (`1.6.0`), minor (`1.6`), and major (`1`), so you can pin `poliuscorp/flow:1` to get fixes but not breaking changes. To roll back, set the previous version's tag in `docker-compose.yml` and run `docker compose up -d` again. Database changes are additive, so the older version still runs on upgraded data. To restore older data instead, stop the container and put back a backup or the automatic pre-upgrade copy.

## Configuration

All settings are optional environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOW_PASSWORD` | – | Sets the password on start if none is set. See [Password](#password). |
| `FLOW_RESET_PASSWORD` | – | `1` removes the password and all sessions on start. |
| `PUID`, `PGID` | `1000` | User and group the app runs as. They need read access to the music folder. |
| `FLOW_TRUSTED_PROXIES` | – | Reverse proxy addresses or CIDRs, comma-separated. Client addresses are read from `X-Forwarded-For` for requests from these. |
| `FLOW_WATCHER` | `auto` | How new files are noticed: `native` (filesystem events), `polling` (periodic checks), or `auto` to choose. Use `polling` if changes go unnoticed, for example on network shares. |
| `FLOW_POLL_INTERVAL` | – | Seconds between checks in polling mode. Longer intervals let NAS disks spin down. |
| `FLOW_WATCH_DEBOUNCE` | `2` | Seconds to wait for file changes to settle before scanning. |
| `FLOW_REPAIR` | `on` | `off` stops Flow making repaired copies of files whose tags can't be read. |
| `FLOW_AUTO_HEAL` | `on` | `off` skips the check on start that finds files an older version indexed wrongly and queues them for repair. |
| `FLOW_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, or `ERROR`. |
| `DEMO` | – | `true` fills an empty library with silent demo tracks. |

## Development

You'll need Python 3.15, Node 26, [uv](https://docs.astral.sh/uv/), and ffmpeg.

```bash
# Backend: http://127.0.0.1:8000 (music from ./music, data in ./.data)
cd backend
uv venv .venv && uv pip install -p .venv -r requirements.txt -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload

# Frontend: http://localhost:5173 (proxies /api to the backend)
cd frontend
npm ci && npm run dev
```

Checks: `.venv/bin/ruff check .` and `.venv/bin/python -m pytest tests -q` in `backend/`, then `npm run lint`, `npm test`, and `npm run build` in `frontend/`. After changing the API, run `npm run gen:api` with the backend running, and commit `src/api/schema.d.ts`. CI checks that it's in sync.

Python dependencies go in `backend/requirements.in`. Then regenerate the hash-locked `requirements.txt` with the `uv pip compile` command at the top of that file.

To release, set the same version in `backend/app/__init__.py` and `frontend/package.json`, then publish a GitHub release tagged `vX.Y.Z`. The release workflow stops if the tag and the version don't match.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
