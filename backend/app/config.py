"""Runtime configuration, resolved from the environment.

Defaults target local development (paths relative to the working directory);
the Dockerfile / docker-compose.yml set the container values explicitly
(see DESIGN.md §7, §10).
"""

from __future__ import annotations

import os
from pathlib import Path


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).expanduser().resolve()


MUSIC_DIR = _env_path("FLOW_MUSIC_DIR", "./music")
DATA_DIR = _env_path("FLOW_DATA_DIR", "./.data")
DB_PATH = DATA_DIR / "flow.db"

# Built frontend, served by FastAPI when present (prod convenience).
# nginx serves the same directory in the container; see nginx/default.conf.
DIST_DIR = Path(os.environ["FLOW_DIST_DIR"]).resolve() if "FLOW_DIST_DIR" in os.environ else None

# Supported audio formats for the MVP scanner (DESIGN.md §3).
LIBRARY_EXTENSIONS: frozenset[str] = frozenset({".mp3", ".flac", ".m4a", ".ogg"})
