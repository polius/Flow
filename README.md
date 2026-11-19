<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="Flow — an eighth note on a rounded tile" width="72">
</picture>

<h1>Flow</h1>

<p>
  <strong>Your music, streamed from your own server.</strong>
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

## Features

- **Your library, as it is.** MP3, FLAC, M4A, and OGG, organized by their tags. New files show up on their own.
- **Plays well.** Gapless playback (measured in Chrome; see below), volume normalization, and keyboard shortcuts (press `?`).
- **Favorites, playlists, and a queue** saved on the server, so any browser picks up where you left off. If another device starts playing, the first one says so and offers to take the queue back.
- **Lyrics from your own files**: a `.lrc` (synced) or `.txt` beside the song, or the lyrics tag. Nothing is fetched from the internet.
- **A listening history**: a song counts once you have heard 30 seconds (or half of a shorter song). Home shows what you play most.
- **Scrobbling to ListenBrainz**, off until you paste a token in **Settings → Scrobbling**. It is the only thing that makes Flow talk to the outside, and it sends only each counted song's title, artist, album, length and the time you played it.
- **Edit tags without touching your files.** Edits live in Flow's database.
- **Repairs files browsers can't play**, such as stream rips saved as `.mp3`.
- **Works on your phone**, added to the Home Screen like an app.

## Quick demo

```bash
docker run --rm -e DEMO=true -p 8080:8080 poliuscorp/flow
```

Open http://localhost:8080. The demo songs are silent placeholders.

## Set up

```bash
curl -O https://raw.githubusercontent.com/polius/Flow/main/docker-compose.yml
docker compose up -d
```

This creates a `flow/` folder next to the compose file. Put your music in `flow/music/`.

> If your music belongs to another user (Synology is often `1026:100`, Unraid `99:100`), set `PUID` and `PGID` to match.

## Adding music

Copy files into `flow/music/`, in any folder structure. Albums and artists come from the files' tags, not folder names; untagged files use the file name as the title.

New, changed, and deleted files are picked up automatically. To scan right away, use **Settings → Library → Rescan**.

### Browser support

Flow streams files as they are, without transcoding:

| Format | Chrome, Edge, Firefox | Safari |
| --- | --- | --- |
| MP3, FLAC, M4A (AAC) | ✓ | ✓ |
| M4A (ALAC) | ✓ as a FLAC copy | ✓ as a FLAC copy |
| OGG (Vorbis, Opus) | ✓ | Recent versions |

Apple Lossless (ALAC) plays only in Safari, so Flow keeps a lossless FLAC copy of each ALAC file in `flow/data/repaired` and streams that. The original is never touched, and the copy is removed with it. Each copy takes about the original's size again, and the first scan of a large ALAC library takes longer. With `FLOW_REPAIR=off`, ALAC files are not copied and play in Safari only.

Songs on an album follow each other without a gap in Chrome: about 5 ms, measured on one continuous tone cut into two files, FLAC and MP3 alike. Firefox leaves a short gap (13 to 45 ms in the same test). Desktop Safari was not measured; WebKit, the engine under it, left about half a second.

On iPhone and iPad, songs change with a short gap and volume normalization is off. iOS keeps music playing with the screen locked only when the browser plays each file directly, one at a time.

## On your phone

Open Flow in the browser and add it to the Home Screen (**Share → Add to Home Screen** on iPhone, **Install app** on Android). Pick a light or dark icon in **Settings → Appearance**.

## Password

**There's no password by default**, so anyone who can reach the port can use Flow. Set one in **Settings → Access**, or with `FLOW_PASSWORD`.

Forgot it? Start the container once with `FLOW_RESET_PASSWORD=1`, then remove the variable.

## HTTPS and reverse proxies

Put Flow behind a reverse proxy for HTTPS, and publish the port on localhost only (`"127.0.0.1:8080:8080"`). The proxy must not buffer responses, must allow 12 MB uploads, and must send `X-Forwarded-For` and `X-Forwarded-Proto`. Set `FLOW_TRUSTED_PROXIES` to the proxy's address.

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
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 12m;
}
```

## Backups

Everything Flow creates lives in `flow/data/`; your music is never modified. Stop the container before copying it:

```bash
docker compose stop && cp -a flow/data flow-data-backup && docker compose start
```

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
| `FLOW_PASSWORD` | – | Sets the password on start if none is set. |
| `FLOW_RESET_PASSWORD` | – | `1` removes the password and signs everyone out. |
| `PUID`, `PGID` | `1000` | User and group Flow runs as. |
| `FLOW_TRUSTED_PROXIES` | – | Reverse proxy addresses or CIDRs. |
| `FLOW_WATCHER` | `auto` | `native`, `polling`, or `auto`. Use `polling` for network shares. |
| `FLOW_POLL_INTERVAL` | `60` | Seconds between checks in polling mode. |
| `FLOW_WATCH_DEBOUNCE` | `2` | Seconds to wait for changes to settle before scanning. |
| `FLOW_REPAIR` | `on` | `off` turns off repairing unplayable files. |
| `FLOW_AUTO_HEAL` | `on` | `off` skips the file re-check after an upgrade. |
| `FLOW_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, or `ERROR`. |
| `FLOW_LISTENBRAINZ_URL` | `https://api.listenbrainz.org` | A self-hosted ListenBrainz. Use `https`: the token travels with every request. |
| `DEMO` | – | `true` fills an empty library with silent demo songs. |

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
