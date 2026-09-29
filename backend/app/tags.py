"""Tag parsing via mutagen (DESIGN.md §3): one normalized shape out of
ID3v2.2/2.3/2.4 (mp3), Vorbis comments (flac/ogg), and MP4 atoms (m4a).

Corrupt or unreadable files yield None — the scanner skips and logs them,
never crashes (DESIGN.md §11.6).
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.flac import FLAC
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

log = logging.getLogger("flow.tags")

_FALLBACK_TRACK_RE = re.compile(r"^\s*(\d{1,3})\s*[-._)\s]+\s*(.+?)\s*$")


@dataclass
class ParsedTags:
    title: str | None
    artist: str | None
    album_artist: str | None
    album: str | None
    track_no: int | None
    disc_no: int | None
    year: int | None
    duration: float
    bitrate: int | None
    sample_rate: int | None
    picture: tuple[bytes, str] | None  # (bytes, mime) — sniffed later if needed


def parse_audio(path: Path) -> ParsedTags | None:
    """Parse one file. The whole body runs inside the guarded call: mutagen
    can raise while *reading* (truncated/zero-byte, wrong container) or while
    *decoding frames* (malformed text encodings), and neither may crash the
    scan (DESIGN.md §11.6)."""
    try:
        return _parse_audio(path)
    except Exception:  # noqa: BLE001
        log.warning("Unreadable audio file skipped: %s", path, exc_info=True)
        return None


def _parse_audio(path: Path) -> ParsedTags:
    audio = MutagenFile(str(path), easy=False)
    if audio is None or audio.info is None:
        log.warning("Unrecognized audio file skipped: %s", path)
        return None

    info = audio.info
    duration = float(info.length) if info.length is not None else 0.0
    if not math.isfinite(duration) or duration < 0:
        duration = 0.0
    bitrate = getattr(info, "bitrate", None)
    sample_rate = getattr(info, "sample_rate", None)

    title = artist = album_artist = album = None
    track_no = disc_no = year = None
    picture: tuple[bytes, str] | None = None
    tags = audio.tags

    if isinstance(tags, ID3):
        title = _id3_first(tags, "TIT2")
        artist = _id3_first(tags, "TPE1")
        album_artist = _id3_first(tags, "TPE2")
        album = _id3_first(tags, "TALB")
        track_no = _id3_slash(_id3_first(tags, "TRCK"))
        disc_no = _id3_slash(_id3_first(tags, "TPOS"))
        year = _year(_id3_first(tags, "TDRC") or _id3_first(tags, "TYER"))
    elif isinstance(audio, FLAC):
        title = _vorbis_first(tags, "title")
        artist = _vorbis_first(tags, "artist")
        album_artist = _vorbis_first(tags, "albumartist")
        album = _vorbis_first(tags, "album")
        track_no = _int_or_slash(_vorbis_first(tags, "tracknumber"))
        disc_no = _int_or_slash(_vorbis_first(tags, "discnumber"))
        year = _year(_vorbis_first(tags, "date") or _vorbis_first(tags, "year"))
    elif isinstance(audio, MP4):
        if tags:
            title = _mp4_first(tags, "\xa9nam")
            artist = _mp4_first(tags, "\xa9ART")
            album_artist = _mp4_first(tags, "aART")
            album = _mp4_first(tags, "\xa9alb")
            track_no = _mp4_index(tags, "trkn")
            disc_no = _mp4_index(tags, "disk")
            year = _year(_mp4_first(tags, "\xa9day"))
    else:
        # Ogg Vorbis and other VorbisComment-based containers.
        title = _vorbis_first(tags, "title")
        artist = _vorbis_first(tags, "artist")
        album_artist = _vorbis_first(tags, "albumartist")
        album = _vorbis_first(tags, "album")
        track_no = _int_or_slash(_vorbis_first(tags, "tracknumber"))
        disc_no = _int_or_slash(_vorbis_first(tags, "discnumber"))
        year = _year(_vorbis_first(tags, "date") or _vorbis_first(tags, "year"))

    return ParsedTags(
        title=title,
        artist=artist,
        album_artist=album_artist,
        album=album,
        track_no=track_no,
        disc_no=disc_no,
        year=year,
        duration=duration,
        bitrate=int(bitrate) if bitrate and math.isfinite(bitrate) else None,
        sample_rate=int(sample_rate) if sample_rate else None,
        picture=picture,
    )


def derive_from_filename(rel_path: str) -> tuple[int | None, str]:
    """Fallback when tags are missing (DESIGN.md §4): "01 - Song.mp3" →
    (1, "Song"). Everything else keeps the file stem as the title."""
    stem = Path(rel_path).stem
    match = _FALLBACK_TRACK_RE.match(stem)
    if match and match.group(2):
        return int(match.group(1)), match.group(2)
    return None, stem


def _id3_first(tags: ID3, key: str) -> str | None:
    frames = tags.getall(key)
    if not frames or not frames[0].text:
        return None
    value = str(frames[0].text[0]).strip()
    return value or None


def _id3_slash(value: str | None) -> int | None:
    if not value:
        return None
    return _int_or_slash(value)


def _vorbis_first(tags, key: str) -> str | None:
    if tags is None:
        return None
    values = tags.get(key)
    if not values:
        return None
    value = str(values[0]).strip()
    return value or None


def _mp4_first(tags, key: str) -> str | None:
    values = tags.get(key)
    if not values:
        return None
    value = str(values[0]).strip()
    return value or None


def _mp4_index(tags, key: str) -> int | None:
    values = tags.get(key)
    if not values:
        return None
    pair = values[0]
    if isinstance(pair, (tuple, list)) and pair:
        number = int(pair[0])
        return number or None
    return None


def _int_or_slash(value: str | None) -> int | None:
    if not value:
        return None
    head = str(value).split("/", 1)[0].strip()
    try:
        return int(head) or None
    except ValueError:
        return None


def _year(value: str | None) -> int | None:
    if not value:
        return None
    match = re.search(r"\d{4}", str(value))
    return int(match.group(0)) if match else None
