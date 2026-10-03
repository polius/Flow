"""Tag parsing via mutagen: one normalized shape out of ID3v2.2/2.3/2.4 (mp3), Vorbis comments (flac/ogg), and MP4 atoms (m4a)."""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.flac import FLAC
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

log = logging.getLogger("flow.tags")

_FALLBACK_TRACK_RE = re.compile(r"^\s*(\d{1,3})\s*[-._)\s]+\s*(.+?)\s*$")

# "A feat. B" / "A ft. B" / "A featuring B" — the one credit split that is
# safe to infer from a plain string. "&" stays intact ("Simon & Garfunkel"
# is one artist); real multi-artist credits arrive as repeated tag values.
_FEATURED_RE = re.compile(
    r"\s+(?:feat\.?|ft\.?|featuring)\s+", re.IGNORECASE
)

# Genres: ";" and "/" separate (the two conventions taggers actually write);
# ID3v2.3's parenthesized numeric refs ("(17)Rock") are stripped to the name.
_GENRE_SPLIT_RE = re.compile(r"\s*[;/]\s*")
_GENRE_REF_RE = re.compile(r"^\(\d+\)\s*")

# ReplayGain: "-7.2 dB", "−7.2", "+3.1dB" — value + optional unit.
_REPLAYGAIN_RE = re.compile(r"^([+-]?\d+(?:\.\d+)?)\s*(?:dB)?\s*$")


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
    # `artists` is the full main-credit list (first entry mirrors `artist`);
    # taggers write collaboration as repeated tag values, not "&" strings.
    artists: list[str] = field(default_factory=list)
    featured: list[str] = field(default_factory=list)
    composers: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    # Pre-computed track gain in dB from ReplayGain tags, when the file
    # carries one — the fast path that spares the analysis pass.
    replaygain_db: float | None = None


def parse_audio(path: Path) -> ParsedTags | None:
    """Parse one file. The whole body runs inside the guarded call: mutagen
    can raise while *reading* (truncated/zero-byte, wrong container) or while
    *decoding frames* (malformed text encodings), and neither may crash the
    scan. Each failure logs exactly one actionable line — the full traceback
    stays at DEBUG so startup output stays readable."""
    try:
        return _parse_audio(path)
    except Exception as exc:  # noqa: BLE001
        mislabel = _mislabeled_container(path)
        if mislabel:
            log.warning(
                "Unreadable audio file skipped: %s — bytes are %s, not what the "
                "extension claims (re-encode or rename to index it)",
                path, mislabel,
            )
        else:
            log.warning(
                "Unreadable audio file skipped: %s (%s: %s)",
                path, type(exc).__name__, exc,
            )
        log.debug("Audio parse traceback for %s", path, exc_info=True)
        return None


def _mislabeled_container(path: Path) -> str | None:
    """Sniff the leading bytes for a container other than the extension's.
    Stream-ripped files often arrive as fragmented MP4/DASH (or WAV/FLAC)
    data wearing an .mp3 name — mutagen can never decode those, and neither
    can the browser, so the skip is worth naming precisely. Failure-path
    only, one bounded read per rejected file."""
    try:
        with path.open("rb") as fh:
            head = fh.read(65536)
    except OSError:
        return None
    if b"ftyp" in head:
        brand = head[head.index(b"ftyp") + 4 : head.index(b"ftyp") + 8]
        name = brand.decode("ascii", "replace").strip() or "iso"
        label = "DASH" if name == "dash" else "MP4"
        return f"{label}/{name} (ISO-BMFF) container"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "WAV (RIFF) file"
    if head[:4] == b"fLaC":
        return "FLAC file"
    if head[:4] == b"OggS":
        return "Ogg container"
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
    raw_artists: list[str] = []
    raw_featured: list[str] = []
    composers: list[str] = []
    raw_genres: list[str] = []
    replaygain_db: float | None = None
    tags = audio.tags

    if isinstance(tags, ID3):
        title = _id3_first(tags, "TIT2")
        raw_artists = _id3_all(tags, "TPE1")
        album_artist = _id3_first(tags, "TPE2")
        album = _id3_first(tags, "TALB")
        track_no = _id3_slash(_id3_first(tags, "TRCK"))
        disc_no = _id3_slash(_id3_first(tags, "TPOS"))
        year = _year(_id3_first(tags, "TDRC") or _id3_first(tags, "TYER"))
        composers = _id3_all(tags, "TCOM")
        raw_genres = _id3_all(tags, "TCON")
        replaygain_db = _id3_replaygain(tags)
    elif isinstance(audio, FLAC):
        title = _vorbis_first(tags, "title")
        raw_artists = _vorbis_all(tags, "artist")
        album_artist = _vorbis_first(tags, "albumartist")
        album = _vorbis_first(tags, "album")
        track_no = _int_or_slash(_vorbis_first(tags, "tracknumber"))
        disc_no = _int_or_slash(_vorbis_first(tags, "discnumber"))
        year = _year(_vorbis_first(tags, "date") or _vorbis_first(tags, "year"))
        composers = _vorbis_all(tags, "composer")
        raw_genres = _vorbis_all(tags, "genre")
        replaygain_db = _gain_db(_vorbis_first(tags, "replaygain_track_gain"))
    elif isinstance(audio, MP4):
        if tags:
            title = _mp4_first(tags, "\xa9nam")
            raw_artists = _mp4_all(tags, "\xa9ART")
            album_artist = _mp4_first(tags, "aART")
            album = _mp4_first(tags, "\xa9alb")
            track_no = _mp4_index(tags, "trkn")
            disc_no = _mp4_index(tags, "disk")
            year = _year(_mp4_first(tags, "\xa9day"))
            composers = _mp4_all(tags, "\xa9wrt")
            raw_genres = _mp4_all(tags, "\xa9gen")
            replaygain_db = _mp4_replaygain(tags)
    else:
        # Ogg Vorbis and other VorbisComment-based containers.
        title = _vorbis_first(tags, "title")
        raw_artists = _vorbis_all(tags, "artist")
        album_artist = _vorbis_first(tags, "albumartist")
        album = _vorbis_first(tags, "album")
        track_no = _int_or_slash(_vorbis_first(tags, "tracknumber"))
        disc_no = _int_or_slash(_vorbis_first(tags, "discnumber"))
        year = _year(_vorbis_first(tags, "date") or _vorbis_first(tags, "year"))
        composers = _vorbis_all(tags, "composer")
        raw_genres = _vorbis_all(tags, "genre")
        replaygain_db = _gain_db(_vorbis_first(tags, "replaygain_track_gain"))

    # Credit splitting: repeated tag values are full main credits; the
    # "feat." inside one string demotes its tail to the featured role.
    artists: list[str] = []
    featured: list[str] = []
    for value in raw_artists:
        main, extra = _split_featured(value)
        if main and main not in artists:
            artists.append(main)
        for name in extra:
            if name not in featured:
                featured.append(name)
    for value in raw_featured:
        if value and value not in featured:
            featured.append(value)
    artist = artists[0] if artists else None

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
        artists=artists,
        featured=featured,
        composers=_dedupe(composers),
        genres=_normalize_genres(raw_genres),
        replaygain_db=replaygain_db,
    )


def derive_from_filename(rel_path: str) -> tuple[int | None, str]:
    """Fallback when tags are missing: "01 - Song.mp3" → (1, "Song").
    Everything else keeps the file stem as the title."""
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


def _id3_all(tags: ID3, key: str) -> list[str]:
    """Every text value across every frame of `key` — taggers write
    collaboration as repeated values (ID3v2.4) or repeated frames."""
    out: list[str] = []
    for frame in tags.getall(key):
        for entry in getattr(frame, "text", []) or []:
            value = str(entry).strip()
            if value:
                out.append(value)
    return out


def _id3_replaygain(tags: ID3) -> float | None:
    """TXXX frame with descriptor REPLAYGAIN_TRACK_GAIN (the ID3 convention)."""
    for frame in tags.getall("TXXX"):
        desc = str(getattr(frame, "desc", "")).strip().lower()
        if desc == "replaygain_track_gain":
            values = getattr(frame, "text", []) or []
            if values:
                return _gain_db(str(values[0]))
    return None


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


def _vorbis_all(tags, key: str) -> list[str]:
    if tags is None:
        return []
    return [v.strip() for v in tags.get(key) or [] if str(v).strip()]


def _mp4_first(tags, key: str) -> str | None:
    values = tags.get(key)
    if not values:
        return None
    value = str(values[0]).strip()
    return value or None


def _mp4_all(tags, key: str) -> list[str]:
    values = tags.get(key) or []
    return [str(v).strip() for v in values if str(v).strip()]


def _mp4_replaygain(tags) -> float | None:
    """Freeform atom ----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN (the MP4
    convention — values are bytes inside a list)."""
    values = tags.get("----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN")
    if not values:
        return None
    try:
        return _gain_db(bytes(values[0]).decode("utf-8", "replace"))
    except (IndexError, TypeError):
        return None


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


def _split_featured(value: str | None) -> tuple[str | None, list[str]]:
    """"A feat. B" → ("A", ["B"]). A value without the marker is one main
    credit; anything with no leading name at all yields (None, [])."""
    if not value or not value.strip():
        return None, []
    parts = _FEATURED_RE.split(value.strip(), maxsplit=1)
    if len(parts) == 1:
        return parts[0].strip() or None, []
    main = parts[0].strip() or None
    rest = parts[1].strip()
    return main, [rest] if rest else []


def _normalize_genres(raw: list[str]) -> list[str]:
    """Genre strings → a deduped, order-preserved list. ';' and '/' split
    (the two conventions taggers actually write); ID3v2.3's "(17)" numeric
    refs are stripped to the name. Case-insensitive dedupe."""
    out: list[str] = []
    seen: set[str] = set()
    for value in raw:
        for piece in _GENRE_SPLIT_RE.split(value):
            name = _GENRE_REF_RE.sub("", piece).strip()
            if not name:
                continue
            key = name.casefold()
            if key in seen:
                continue
            seen.add(key)
            out.append(name)
    return out


def _gain_db(value: str | None) -> float | None:
    """"-7.2 dB" → -7.2; anything unparseable → None (analysis will decide)."""
    if not value:
        return None
    text = str(value).strip().replace("−", "-")  # tags sometimes carry U+2212
    match = _REPLAYGAIN_RE.match(text)
    if match is None:
        return None
    try:
        gain = float(match.group(1))
    except ValueError:
        return None
    return gain if math.isfinite(gain) else None


def _dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = value.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out
