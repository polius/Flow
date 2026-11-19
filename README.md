<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="Flow — an eighth note on a rounded tile" width="72">
</picture>

<h1>Flow</h1>

<p>
  <strong>A self-hosted music server and player, in one Docker container.</strong>
</p>

<p>
  <a href="https://github.com/polius/Flow/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/polius/Flow/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/polius/Flow/actions/workflows/release.yml"><img alt="Release" src="https://github.com/polius/Flow/actions/workflows/release.yml/badge.svg"></a>
  <a href="https://github.com/polius/Flow/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/polius/Flow"></a>
  <a href="https://hub.docker.com/r/poliuscorp/flow"><img alt="Docker Pulls" src="https://img.shields.io/docker/pulls/poliuscorp/flow"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
</p>

<a href="https://pol.alzina.dev/videos/flow.mp4"><img src="assets/video-poster.png" alt="Flow's album view. Click to watch the one-minute video: building a library, playing, searching and organizing your music" width="100%"></a>

</div>

Point Flow at a folder of music and it becomes a library you can play from any browser, or from your phone's Home Screen. It streams your files as they are, never modifies them, and never calls out to the internet.

## Features

- **Gapless playback** in Chrome ([details](docs/guide.md#browser-support)), volume normalization, and keyboard shortcuts.
- **Favorites, playlists, and a queue** saved on the server, so any browser picks up where you left off.
- **Lyrics from your own files**: a `.lrc` or `.txt` beside the song, or the lyrics tag.
- **Repairs files browsers can't play**, such as stream rips saved as `.mp3`.
- **Edit tags** without touching your files.
- **MP3, FLAC, M4A, and OGG**, organized by their tags. New files show up on their own.
- **Listening history**, with your most played on Home.
- **Works on your phone**, added to the Home Screen like an app.

## Quick demo

```bash
docker run --rm -e DEMO=true -p 8080:8080 poliuscorp/flow
```

Open http://localhost:8080. The demo songs are silent placeholders.

## Install

```bash
curl -O https://raw.githubusercontent.com/polius/Flow/main/docker-compose.yml
docker compose up -d
```

This creates a `flow/` folder next to the compose file. Put your music in `flow/music/`.

## Adding music

Copy files into `flow/music/`, in any folder structure. Albums and artists come from the files' tags, not folder names; untagged files use the file name as the title.

New, changed, and deleted files are picked up automatically. To scan right away, use **Settings → Library → Rescan**.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Flow backs up its database before upgrading it. To roll back, set the previous version's tag (for example `poliuscorp/flow:1.5.0`) and run `docker compose up -d`; you may need to sign in again.

After upgrading, run **Settings → Library → Full rescan** once to re-check and repair every file with the new version.

## Configuration

All optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOW_PASSWORD` | – | Sets the password on start if none is set. There is none by default ([details](docs/guide.md#password)). |
| `FLOW_RESET_PASSWORD` | – | `1` removes the password and signs everyone out. |
| `PUID`, `PGID` | `1000` | User and group Flow runs as ([details](docs/guide.md#file-permissions)). |
| `FLOW_TRUSTED_PROXIES` | – | Reverse proxy addresses or CIDRs ([setup](docs/guide.md#https-and-reverse-proxies)). |
| `FLOW_WATCHER` | `auto` | `native`, `polling`, or `auto`. Use `polling` for network shares. |
| `FLOW_POLL_INTERVAL` | `60` | Seconds between checks in polling mode. |
| `FLOW_WATCH_DEBOUNCE` | `2` | Seconds to wait for changes to settle before scanning. |
| `FLOW_REPAIR` | `on` | `off` turns off repairing unplayable files. |
| `FLOW_AUTO_HEAL` | `on` | `off` skips the file re-check after an upgrade. |
| `FLOW_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, or `ERROR`. |
| `DEMO` | – | `true` fills an empty library with silent demo songs. |

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
