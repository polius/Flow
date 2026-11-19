# Flow guide

The details the [README](../README.md) leaves out.

## File permissions

Flow runs as user and group `1000` by default. If your music belongs to another user (Synology is often `1026:100`, Unraid `99:100`), set `PUID` and `PGID` to match.

## Browser support

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
