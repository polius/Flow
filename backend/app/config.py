"""Runtime configuration, resolved from the environment (FLOW_* vars are dev/test plumbing; the Dockerfile bakes container values via ENV)."""

from __future__ import annotations

import os
from pathlib import Path


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).expanduser().resolve()


MUSIC_DIR = _env_path("FLOW_MUSIC_DIR", "./music")
DATA_DIR = _env_path("FLOW_DATA_DIR", "./.data")
DB_PATH = DATA_DIR / "flow.db"

# "nginx" streams via an X-Accel-Redirect into the internal /music-internal/
# location; "direct" streams from FastAPI. Dev defaults to direct; the Docker
# image sets nginx.
STREAM_MODE = os.environ.get("FLOW_STREAM_MODE", "direct")

# Demo mode: first boot with an empty library generates a showcase catalog
# (files + favorites + playlists) instead of sitting empty. With no volume
# mounted the whole thing is ephemeral: docker run --rm -e DEMO=true …
DEMO = os.environ.get("DEMO", "").strip().lower() in {"1", "true", "yes", "on"}
AUDIO_MIME = {
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "m4a": "audio/mp4",
    "ogg": "audio/ogg",
    "opus": "audio/opus",
    "wav": "audio/wav",
}

# Built frontend, served by FastAPI when present (prod convenience).
# nginx serves the same directory in the container; see nginx/default.conf.
DIST_DIR = Path(os.environ["FLOW_DIST_DIR"]).resolve() if "FLOW_DIST_DIR" in os.environ else None

LIBRARY_EXTENSIONS: frozenset[str] = frozenset({".mp3", ".flac", ".m4a", ".ogg"})

# Self-healing scan: when a file fails tag parsing, attempt a lossless remux
# of the audio inside into DATA_DIR/repaired/. Originals are never modified;
# FLOW_REPAIR=off disables.
REPAIR = os.environ.get("FLOW_REPAIR", "on").strip().lower() not in {"off", "0", "false"}

# inotify does not propagate through Docker bind mounts (especially from
# macOS hosts), so "auto" picks the polling observer inside containers.
WATCHER_MODE = os.environ.get("FLOW_WATCHER", "auto")
POLL_INTERVAL = float(os.environ.get("FLOW_POLL_INTERVAL", "5.0"))
WATCH_DEBOUNCE = float(os.environ.get("FLOW_WATCH_DEBOUNCE", "2.0"))
