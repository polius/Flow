"""Runtime configuration, resolved from the environment.

Defaults target local development (paths relative to the working directory);
the Dockerfile bakes the container values in via ENV (see DESIGN.md §7, §10).
The FLOW_* variables are dev/test plumbing — end users configure nothing:
docker-compose.yml just mounts one host folder at /flow.
"""

from __future__ import annotations

import os
from pathlib import Path


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).expanduser().resolve()


MUSIC_DIR = _env_path("FLOW_MUSIC_DIR", "./music")
DATA_DIR = _env_path("FLOW_DATA_DIR", "./.data")
DB_PATH = DATA_DIR / "flow.db"

# Audio streaming (DESIGN.md §13.1): "nginx" answers with an X-Accel-Redirect
# into the internal /music-internal/ location (native sendfile + Range);
# "direct" streams from FastAPI (Starlette FileResponse handles Range).
# Dev defaults to direct; the Docker image sets nginx.
STREAM_MODE = os.environ.get("FLOW_STREAM_MODE", "direct")
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

# Supported audio formats for the MVP scanner (DESIGN.md §3).
LIBRARY_EXTENSIONS: frozenset[str] = frozenset({".mp3", ".flac", ".m4a", ".ogg"})

# Self-healing scan (DESIGN.md §38): when a file fails tag parsing, attempt a
# lossless remux of the audio inside into a canonical container under
# DATA_DIR/repaired/. Originals are never modified; FLOW_REPAIR=off disables.
REPAIR = os.environ.get("FLOW_REPAIR", "on").strip().lower() not in {"off", "0", "false"}

# Filesystem watcher (DESIGN.md §13.6): inotify does not propagate through
# Docker bind mounts (especially from macOS hosts), so "auto" picks the
# polling observer inside containers. Override: "native" | "polling".
WATCHER_MODE = os.environ.get("FLOW_WATCHER", "auto")
POLL_INTERVAL = float(os.environ.get("FLOW_POLL_INTERVAL", "5.0"))

# Watcher events are debounced before a reconcile scan runs.
WATCH_DEBOUNCE = float(os.environ.get("FLOW_WATCH_DEBOUNCE", "2.0"))
