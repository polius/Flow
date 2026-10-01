"""Track loudness analysis for Sound Check (UX review §2.3).

Reference: EBU R128 / ReplayGain-style level matching. Each track gets a
`gain_db` = (reference loudness − track integrated loudness), applied
client-side so album-to-album volume whiplash stops. Two sources, in order:

1. The file's own ReplayGain tag (parsed by app.tags — free, exact).
2. Analysis with ffmpeg's `ebur128` filter (integrated LUFS), when ffmpeg
   is on PATH. Without ffmpeg the gain simply stays NULL and playback is
   untouched — the feature degrades, it never blocks a scan.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("flow.loudness")

# Streaming-era reference (Spotify/Apple territory; audible-consistent and
# conservative for dynamic material). Gain is clamped so a pathological
# file can neither blow out nor vanish.
TARGET_LUFS = -14.0
MIN_GAIN_DB = -24.0
MAX_GAIN_DB = 6.0

# Full-file decode at ~100× realtime; even a 40-minute live set is seconds.
FFMPEG_TIMEOUT_S = 300

_SUMMARY_I_RE = re.compile(
    r"Summary:.*?I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", re.DOTALL
)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def parse_integrated_lufs(output: str) -> float | None:
    """The ebur128 filter prints per-window stats, then one Summary block.
    Only the Summary's `I:` is the integrated loudness."""
    match = _SUMMARY_I_RE.search(output)
    if match is None:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    return value if -70.0 <= value <= 0.0 else None


def analyze_file(path: Path) -> float | None:
    """Track gain in dB for one file, or None when it can't be measured."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return None
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [
                ffmpeg,
                "-nostats",
                "-hide_banner",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                "-af",
                "ebur128=peak=none",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        log.warning("Loudness analysis failed: %s", path, exc_info=True)
        return None
    lufs = parse_integrated_lufs(proc.stderr or "")
    if lufs is None:
        return None
    return clamp_gain(TARGET_LUFS - lufs)


def clamp_gain(gain_db: float) -> float:
    return round(min(MAX_GAIN_DB, max(MIN_GAIN_DB, gain_db)), 1)
