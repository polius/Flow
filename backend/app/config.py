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
    # Indexed only when repair can't produce a browser-safe copy (FLOW_REPAIR
    # off, no ffmpeg): an honest type beats audio/mpeg over AIFF bytes.
    "aiff": "audio/aiff",
    "aac": "audio/aac",
}

# Built frontend, served by FastAPI when present (prod convenience).
# nginx serves the same directory in the container; see nginx/default.conf.
DIST_DIR = Path(os.environ["FLOW_DIST_DIR"]).resolve() if "FLOW_DIST_DIR" in os.environ else None

LIBRARY_EXTENSIONS: frozenset[str] = frozenset({".mp3", ".flac", ".m4a", ".ogg"})

# Self-healing scan: when a file fails tag parsing, attempt a lossless remux
# of the audio inside into DATA_DIR/repaired/. Originals are never modified;
# FLOW_REPAIR=off disables.
REPAIR = os.environ.get("FLOW_REPAIR", "on").strip().lower() not in {"off", "0", "false"}

# Startup heal (heal.run_startup_heal): when file detection has improved
# since the library was last scanned, schedule one rescan at boot so rows
# indexed under the old rules are re-checked. FLOW_AUTO_HEAL=off leaves that
# to the next manual or watcher-triggered scan.
AUTO_HEAL = os.environ.get("FLOW_AUTO_HEAL", "on").strip().lower() not in {"off", "0", "false"}

# Filesystem watching: "native" (inotify/FSEvents), "polling", or "auto" —
# native unless the library sits on a filesystem that doesn't deliver
# change events (network shares, FUSE, Docker Desktop's VM file sharing);
# see watcher.py. Polling stats the whole library every POLL_INTERVAL
# seconds, so the default is gentle enough to let NAS disks spin down.
WATCHER_MODE = os.environ.get("FLOW_WATCHER", "auto").strip().lower()
POLL_INTERVAL = float(os.environ.get("FLOW_POLL_INTERVAL", "60"))
WATCH_DEBOUNCE = float(os.environ.get("FLOW_WATCH_DEBOUNCE", "2.0"))
