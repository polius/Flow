"""Lyrics from the listener's own files, never from the internet.

A song's lyrics come from, in order: a `.lrc` file beside it (same name),
the lyrics tag inside it (ID3 USLT, MP4 ©lyr, Vorbis LYRICS or
UNSYNCEDLYRICS), then a `.txt` beside it. Text in the LRC form
(`[mm:ss.xx] line`) is synced: each line carries the time it starts.
Anything else is shown as plain lines.

Read on request, from the path the index holds; nothing is stored. Files
are capped in size, and a sidecar must sit inside the library folder.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import mutagen
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

log = logging.getLogger("flow.lyrics")

# Lyrics are text: far below this. A larger "lyrics" file is not read.
MAX_BYTES = 256 * 1024

_STAMP = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_OFFSET = re.compile(r"^\[offset:\s*([+-]?\d+)\s*\]", re.IGNORECASE)


@dataclass(frozen=True)
class Line:
    time: float | None
    text: str


@dataclass(frozen=True)
class Lyrics:
    synced: bool
    lines: list[Line]


NONE = Lyrics(synced=False, lines=[])


def parse(text: str) -> Lyrics:
    """LRC when any line carries a timestamp, plain lines otherwise."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    raw = text.split("\n")
    if any(_STAMP.match(r.strip()) for r in raw):
        return _parse_lrc(raw)
    lines = [Line(None, r.rstrip()) for r in raw]
    while lines and not lines[0].text:
        lines.pop(0)
    while lines and not lines[-1].text:
        lines.pop()
    return Lyrics(synced=False, lines=lines) if lines else NONE


def _parse_lrc(raw: list[str]) -> Lyrics:
    offset = 0.0
    timed: list[Line] = []
    for r in raw:
        r = r.strip()
        m = _OFFSET.match(r)
        if m:
            # Positive offset: the lyrics come sooner (the LRC convention).
            offset = int(m.group(1)) / 1000
            continue
        stamps = []
        while (m := _STAMP.match(r)) is not None:
            minutes, seconds, frac = m.group(1), m.group(2), m.group(3) or "0"
            stamps.append(int(minutes) * 60 + int(seconds) + int(frac) / 10 ** len(frac))
            r = r[m.end() :]
        if not stamps:
            continue  # metadata ([ar:…], [ti:…]) or a stray line
        for t in stamps:  # [00:12.00][01:30.00] a repeated chorus line
            timed.append(Line(max(0.0, t - offset), r.strip()))
    timed.sort(key=lambda line: line.time or 0.0)
    return Lyrics(synced=True, lines=timed) if timed else NONE


def _read_text(path: Path) -> str | None:
    try:
        if not path.is_file() or path.stat().st_size > MAX_BYTES:
            return None
        return path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return None


def _embedded(path: Path) -> str | None:
    try:
        audio = mutagen.File(path)
    except Exception:  # noqa: BLE001 - an unreadable tag is no lyrics
        return None
    if audio is None or audio.tags is None:
        return None
    tags = audio.tags
    texts: list[str] = []
    if isinstance(tags, ID3):
        texts = [str(frame.text) for frame in tags.getall("USLT")]
    elif isinstance(audio, MP4):
        texts = [str(v) for v in tags.get("\xa9lyr", [])]
    elif hasattr(tags, "get"):
        for key in ("LYRICS", "UNSYNCEDLYRICS", "lyrics", "unsyncedlyrics"):
            values = tags.get(key)
            if values:
                texts = [str(v) for v in values]
                break
    text = next((t for t in texts if t.strip()), None)
    if text is None or len(text.encode("utf-8", errors="replace")) > MAX_BYTES:
        return None
    return text


def for_file(music_dir: Path, rel: str) -> Lyrics:
    """The lyrics for the library file at `rel` (as the index holds it)."""
    root = music_dir.resolve()
    song = (music_dir / rel).resolve()
    if not song.is_relative_to(root):
        return NONE

    def sidecar(suffix: str) -> Path | None:
        path = song.with_suffix(suffix)
        return path if path.resolve().is_relative_to(root) else None

    lrc = sidecar(".lrc")
    if lrc is not None and (text := _read_text(lrc)) is not None:
        lyrics = parse(text)
        if lyrics.lines:
            return lyrics
    if (text := _embedded(song)) is not None:
        lyrics = parse(text)
        if lyrics.lines:
            return lyrics
    txt = sidecar(".txt")
    if txt is not None and (text := _read_text(txt)) is not None:
        return parse(text)
    return NONE
