"""Tag parsing via mutagen: one normalized shape out of ID3v2.2/2.3/2.4 (mp3), Vorbis comments (flac/ogg), and MP4 atoms (m4a); container sniffing for mislabeled files."""

from __future__ import annotations

import base64
import logging
import math
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.aac import AAC
from mutagen.aiff import AIFF
from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.ogg import OggFileType
from mutagen.wave import WAVE

from app.artwork import sniff_mime

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

# Sniffed container → the `format` column (and so the served MIME type).
# The bytes decide, never the file name: AIFF in a .mp3 is "aiff".
CONTAINER_FORMAT: dict[str, str] = {
    "mp3": "mp3",
    "mp4": "m4a",
    "flac": "flac",
    "ogg": "ogg",
    "wav": "wav",
    "aiff": "aiff",
    "adts": "aac",
}
# Containers every mainstream browser demuxes. Anything else that parses
# (AIFF, raw ADTS) goes through repair first, so the stream is a canonical
# copy (wav / m4a) whenever ffmpeg is available.
BROWSER_SAFE: frozenset[str] = frozenset({"mp3", "mp4", "flac", "ogg", "wav"})

_EXTENSION_CONTAINER = {".mp3": "mp3", ".m4a": "mp4", ".flac": "flac", ".ogg": "ogg"}

_CONTAINER_LABEL = {
    "mp3": "MPEG audio frames",
    "mp4": "an MP4 (ISO-BMFF) container",
    "flac": "a FLAC stream",
    "ogg": "an Ogg container",
    "wav": "a WAV (RIFF) file",
    "aiff": "an AIFF file",
    "adts": "raw AAC (ADTS) frames",
}

# Stacked ID3v2 tags are rare but real (rippers that prepend a second tag
# instead of rewriting the first); the walk is bounded all the same.
_MAX_ID3_TAGS = 8
# Junk in front of an ISO-BMFF payload (no header to size it) is searched
# for within this window past the last tag.
_FTYP_SEARCH_WINDOW = 65536
# Behind a plausible MPEG frame header the check is shorter: a few stray
# frames in front of an MP4 are seen, a genuine MP3 is the norm.
_FRAME_FTYP_WINDOW = 16384


@dataclass(frozen=True)
class Sniff:
    """What the bytes are, and where the payload starts (past any ID3v2
    tags, or past junk in front of an ISO-BMFF payload)."""

    container: str  # a CONTAINER_FORMAT key
    offset: int

    @property
    def label(self) -> str:
        return _CONTAINER_LABEL.get(self.container, self.container)


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
    # Embedded cover (bytes, mime), JPEG/PNG only — read in the same pass as
    # the tags, so the scanner never opens the file a second time for art.
    picture: tuple[bytes, str] | None
    # `artists` is the full main-credit list (first entry mirrors `artist`);
    # taggers write collaboration as repeated tag values, not "&" strings.
    artists: list[str] = field(default_factory=list)
    featured: list[str] = field(default_factory=list)
    composers: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    # Track gain in dB from ReplayGain tags, when the file carries one — the
    # fast path that spares the analysis pass. Relative to ReplayGain's
    # −18 LUFS reference, NOT the Sound Check target (see loudness.py).
    replaygain_db: float | None = None
    # TCMP / cpil / COMPILATION: a compilation without an album artist
    # groups under "Various Artists" instead of splitting per track artist.
    compilation: bool = False
    # The container mutagen parsed (a CONTAINER_FORMAT key), the format
    # column it indexes as, and whether browsers can demux it as-is.
    container: str | None = None
    format: str | None = None
    playable: bool = True


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


# ---- container sniffing ------------------------------------------------------


def _synchsafe(data: bytes) -> int:
    return (
        (data[0] & 0x7F) << 21
        | (data[1] & 0x7F) << 14
        | (data[2] & 0x7F) << 7
        | (data[3] & 0x7F)
    )


def id3_payload_offset(fh) -> int:
    """Byte offset just past every stacked ID3v2 tag at the head of `fh`
    (0 when there is none). Each tag's size is in its header — synchsafe
    bytes 6–9, plus the 10-byte header, plus 10 more when the footer flag
    (0x10) is set — so the walk never reads a tag body, however large the
    embedded cover."""
    offset = 0
    for _ in range(_MAX_ID3_TAGS):
        fh.seek(offset)
        header = fh.read(10)
        if (
            len(header) < 10
            or header[:3] != b"ID3"
            or header[3] == 0xFF
            or header[4] == 0xFF
            or any(b & 0x80 for b in header[6:10])
        ):
            break
        size = _synchsafe(header[6:10]) + 10
        if header[5] & 0x10:
            size += 10
        offset += size
    return offset


def _magic(head: bytes) -> str | None:
    """The container whose signature starts `head`, if any."""
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "mp4"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:4] == b"fLaC":
        return "flac"
    if head[:4] in (b"RIFF", b"RF64") and head[8:12] == b"WAVE":
        return "wav"
    if head[:4] == b"FORM" and head[8:12] in (b"AIFF", b"AIFC"):
        return "aiff"
    if len(head) < 4 or head[0] != 0xFF:
        return None
    if (head[1] & 0xF6) == 0xF0:
        return "adts"  # 12-bit sync + layer 00: an AAC ADTS header
    if (head[1] & 0xE0) == 0xE0:
        version = (head[1] >> 3) & 0x03
        layer = (head[1] >> 1) & 0x03
        bitrate = head[2] >> 4
        rate = (head[2] >> 2) & 0x03
        if version != 1 and layer != 0 and bitrate != 0x0F and rate != 0x03:
            return "mp3"  # a plausible MPEG audio frame header
    return None


def _find_ftyp(window: bytes) -> int | None:
    """Offset of the first plausible ISO-BMFF `ftyp` box in `window`: a sane
    box size in front, a printable brand behind."""
    start = 4
    while True:
        i = window.find(b"ftyp", start)
        if i < 0:
            return None
        size = int.from_bytes(window[i - 4 : i], "big")
        brand = window[i + 4 : i + 8]
        if 8 <= size <= 4096 and len(brand) == 4 and all(32 <= b < 127 for b in brand):
            return i - 4
        start = i + 1


def sniff_container(path: Path) -> Sniff | None:
    """What the file's bytes really are, independent of its name — the one
    detection used by the parser guard, by repair and by heal. Walks the
    stacked ID3v2 headers by their declared sizes, then reads the magic at
    exactly that offset: a tag frame that happens to contain "ftyp", or a
    cover big enough to push the payload past any fixed window, can't fool
    it. A few small reads per file; None = no known signature."""
    try:
        with path.open("rb") as fh:
            offset = id3_payload_offset(fh)
            fh.seek(offset)
            container = _magic(fh.read(16))
            if container not in (None, "mp3"):
                return Sniff(container, offset)
            # No signature where the payload should start, or one MPEG frame
            # header — four bytes that occur by chance. Junk (or a couple of
            # stray frames) glued in front of an MP4 is the shape seen in
            # the wild, so look for a real ftyp box a little further on —
            # past the tags only, so a tag frame can never be the decoy.
            fh.seek(offset)
            window = fh.read(_FRAME_FTYP_WINDOW if container else _FTYP_SEARCH_WINDOW)
    except OSError:
        return None
    found = _find_ftyp(window)
    if found is not None:
        return Sniff("mp4", offset + found)
    return Sniff(container, offset) if container else None


def stale_format(path: Path, indexed_format: str | None) -> bool:
    """True when a row's stored format is contradicted by the file's bytes
    (an MP4 stream-rip indexed as mp3, WAV in a .mp3 indexed as mp3), or
    the bytes are a container browsers can't play — either way the file
    needs reprocessing. Unknown signatures never count as stale."""
    sniffed = sniff_container(path)
    if sniffed is None:
        return False
    return (
        CONTAINER_FORMAT[sniffed.container] != indexed_format
        or sniffed.container not in BROWSER_SAFE
    )


def _mutagen_container(audio) -> str | None:
    """mutagen's verdict as a CONTAINER_FORMAT key (None = something else
    entirely, e.g. WavPack or WMA wearing a library extension)."""
    if isinstance(audio, MP3):
        return "mp3"
    if isinstance(audio, MP4):
        return "mp4"
    if isinstance(audio, FLAC):
        return "flac"
    if isinstance(audio, OggFileType):
        return "ogg"
    if isinstance(audio, WAVE):
        return "wav"
    if isinstance(audio, AIFF):
        return "aiff"
    if isinstance(audio, AAC):
        return "adts"
    return None


def _mislabeled_container(path: Path) -> str | None:
    """Name the container the bytes really are when it isn't the one the
    extension claims. Stream-ripped files often arrive as fragmented MP4/DASH
    (or WAV/FLAC/Ogg) data wearing an .mp3 name — the skip (or the repair)
    is worth naming precisely."""
    sniffed = sniff_container(path)
    if sniffed is None or sniffed.container == _EXTENSION_CONTAINER.get(
        path.suffix.lower()
    ):
        return None
    if sniffed.container == "mp4":
        try:
            with path.open("rb") as fh:
                fh.seek(sniffed.offset + 8)
                brand = fh.read(4)
        except OSError:
            brand = b""
        name = brand.decode("ascii", "replace").strip() or "iso"
        label = "DASH" if name == "dash" else "MP4"
        return f"{label}/{name} (ISO-BMFF) container"
    return sniffed.label


# ---- parsing -----------------------------------------------------------------


def _parse_audio(path: Path) -> ParsedTags:
    audio = MutagenFile(str(path), easy=False)
    if audio is None or audio.info is None:
        log.warning("Unrecognized audio file skipped: %s", path)
        return None

    # mutagen's verdict is not proof of what the bytes are. Stream-rips glue
    # an ID3v2 tag onto MP4/DASH (or ADTS, Ogg) data, and mutagen's
    # frame-sync hunt inside such a payload can validate a decoy MP3 header
    # — the file would index as mp3 and the browser would be served
    # audio/mpeg carrying MP4. When the sniffed container disagrees the
    # parse is garbage: hand the file to the repair pass, which strips the
    # junk and remuxes the payload into a canonical container.
    container = _mutagen_container(audio)
    sniffed = sniff_container(path)
    if sniffed is not None and sniffed.container != container:
        log.warning(
            "Mislabeled audio file: %s — bytes are %s, not what %s parsed "
            "(sending it to repair)",
            path, sniffed.label, type(audio).__name__,
        )
        return None

    info = audio.info
    duration = float(info.length) if info.length is not None else 0.0
    if not math.isfinite(duration) or duration < 0:
        duration = 0.0
    bitrate = getattr(info, "bitrate", None)
    sample_rate = getattr(info, "sample_rate", None)

    title = artist = album_artist = album = None
    track_no = disc_no = year = None
    raw_artists: list[str] = []
    composers: list[str] = []
    raw_genres: list[str] = []
    replaygain_db: float | None = None
    compilation = False
    tags = audio.tags

    if isinstance(tags, ID3):
        # MP3, and the ID3 chunk of WAV/AIFF files.
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
        compilation = _truthy(_id3_first(tags, "TCMP"))
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
            compilation = bool((tags.get("cpil") or [False])[0])
    elif tags is not None and hasattr(tags, "get"):
        # FLAC and Ogg Vorbis/Opus/FLAC: VorbisComment-based containers.
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
        compilation = _truthy(_vorbis_first(tags, "compilation"))

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
        picture=embedded_picture(audio),
        artists=artists,
        featured=featured,
        composers=_dedupe(composers),
        genres=_normalize_genres(raw_genres),
        replaygain_db=replaygain_db,
        compilation=compilation,
        container=container,
        format=CONTAINER_FORMAT.get(container or ""),
        playable=container in BROWSER_SAFE,
    )


def embedded_picture(audio) -> tuple[bytes, str] | None:
    """The front cover (picture type 3), else the first picture, from
    whichever tag flavor the file carries. Only bytes that sniff as JPEG or
    PNG count — a declared MIME type is never trusted."""
    candidates: list[tuple[int | None, bytes]] = []
    try:
        tags = audio.tags
        if isinstance(tags, ID3):
            candidates = [(getattr(a, "type", None), a.data) for a in tags.getall("APIC")]
        elif isinstance(audio, FLAC):
            candidates = [(p.type, p.data) for p in audio.pictures]
        elif isinstance(audio, MP4):
            candidates = [(None, bytes(c)) for c in (tags.get("covr") or [])] if tags else []
        elif tags is not None and hasattr(tags, "get"):
            # Ogg: base64 METADATA_BLOCK_PICTURE comments (the FLAC picture
            # block convention).
            for block in tags.get("metadata_block_picture") or []:
                try:
                    pic = Picture(base64.b64decode(block))
                except Exception:  # noqa: BLE001 - malformed picture is not fatal
                    continue
                candidates.append((pic.type, pic.data))
    except Exception:  # noqa: BLE001 - art is a bonus, never a failed parse
        log.debug("Embedded picture unreadable in %s", audio.filename, exc_info=True)
        return None
    candidates.sort(key=lambda c: 0 if c[0] == 3 else 1)  # stable: front first
    for _, data in candidates:
        mime = sniff_mime(data) if data else None
        if mime is not None:
            return data, mime
    return None


def derive_from_filename(rel_path: str) -> tuple[int | None, str]:
    """Fallback when tags are missing: "01 - Song.mp3" → (1, "Song").
    Everything else keeps the file stem as the title."""
    stem = nfc(Path(rel_path).stem)
    match = _FALLBACK_TRACK_RE.match(stem)
    if match and match.group(2):
        return int(match.group(1)), match.group(2)
    return None, stem


def nfc(value: str) -> str:
    """Unicode NFC: macOS writes decomposed (NFD) names and tags, which
    would otherwise make "Beyoncé" two different artists."""
    return unicodedata.normalize("NFC", value)


def _text(value) -> str:
    return nfc(str(value)).strip()


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes"}


def _id3_first(tags: ID3, key: str) -> str | None:
    frames = tags.getall(key)
    if not frames or not frames[0].text:
        return None
    value = _text(frames[0].text[0])
    return value or None


def _id3_all(tags: ID3, key: str) -> list[str]:
    """Every text value across every frame of `key` — taggers write
    collaboration as repeated values (ID3v2.4) or repeated frames."""
    out: list[str] = []
    for frame in tags.getall(key):
        for entry in getattr(frame, "text", []) or []:
            value = _text(entry)
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
    value = _text(values[0])
    return value or None


def _vorbis_all(tags, key: str) -> list[str]:
    if tags is None:
        return []
    return [_text(v) for v in tags.get(key) or [] if _text(v)]


def _mp4_first(tags, key: str) -> str | None:
    values = tags.get(key)
    if not values:
        return None
    value = _text(values[0])
    return value or None


def _mp4_all(tags, key: str) -> list[str]:
    values = tags.get(key) or []
    return [_text(v) for v in values if _text(v)]


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
