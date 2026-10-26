"""Artwork handling: tag-embedded art first, folder fallback, sha1 dedup; blobs are stored as original bytes, never re-encoded.

Only bytes that sniff as JPEG or PNG are ever stored: the MIME type a tag
claims is attacker-controlled (an APIC frame can say image/svg+xml and carry
a <script>), and the artwork endpoint is served from the app's own origin.
Serving re-sniffs too (`served_mime`), so rows stored by older versions are
safe before any rescan. Sized variants (`thumbnail_path`) are JPEG renders
cached under DATA_DIR/artwork-cache/.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import shutil
import sqlite3
import subprocess
import threading
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

log = logging.getLogger("flow.artwork")

FOLDER_ARTWORK_NAMES = (
    "cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png",
)

MIME_JPEG = "image/jpeg"
MIME_PNG = "image/png"
MIME_OCTET = "application/octet-stream"


def sniff_mime(data: bytes) -> str | None:
    """JPEG or PNG by magic bytes — the only types stored."""
    if data[:3] == b"\xff\xd8\xff":
        return MIME_JPEG
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return MIME_PNG
    return None


def served_mime(data: bytes) -> str:
    """The Content-Type to serve a stored blob with, from its bytes alone —
    never the stored column. WebP/GIF are recognized for rows stored before
    sniff-only storage; anything else is octet-stream (downloaded, never
    rendered as a document)."""
    mime = sniff_mime(data)
    if mime is not None:
        return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return MIME_OCTET


def _pick(candidates: list[tuple[bytes, bool]]) -> tuple[bytes, str] | None:
    """(bytes, is_front_cover) pairs in tag order → the front cover if it
    sniffs as an image, else the first picture that does."""
    usable = [(data, front) for data, front in candidates if data and sniff_mime(data)]
    if not usable:
        return None
    data = next((d for d, front in usable if front), usable[0][0])
    return data, sniff_mime(data)


def _extract_embedded(path: Path, suffix: str) -> tuple[bytes, str] | None:
    """Return (image_bytes, mime) from the file's tags, or None. Pictures
    whose bytes aren't JPEG/PNG are skipped whatever MIME the tag claims —
    the folder image then gets its chance."""
    audio = MutagenFile(str(path), easy=False)
    if audio is None or audio.tags is None:
        return None

    if suffix == ".mp3" and isinstance(audio.tags, ID3):
        # Prefer front cover (picture type 3), fall back to the first image.
        return _pick(
            [(apic.data, getattr(apic, "type", None) == 3) for apic in audio.tags.getall("APIC")]
        )

    if suffix == ".flac" and isinstance(audio, FLAC):
        return _pick([(p.data, p.type == 3) for p in audio.pictures])

    if suffix == ".m4a" and isinstance(audio, MP4):
        covers = audio.tags.get("covr") if audio.tags else None
        return _pick([(bytes(c), False) for c in covers or []])

    # Ogg Vorbis / Ogg FLAC: pictures ride in a base64 metadata_block_picture
    # comment (the FLAC-picture convention).
    candidates: list[tuple[bytes, bool]] = []
    for block in audio.tags.get("metadata_block_picture") or []:
        try:
            picture = Picture(base64.b64decode(block))
            candidates.append((picture.data, picture.type == 3))
        except Exception:  # noqa: BLE001 - malformed picture is not fatal
            log.debug("Unreadable metadata_block_picture in %s", path, exc_info=True)
    return _pick(candidates)


def store_artwork(conn, data: bytes, mime: str) -> int:
    """Content-addressed artwork storage (sha1 dedup), shared by the scanner
    and cover uploads. Callers pass a sniffed MIME type."""
    digest = hashlib.sha1(data).hexdigest()
    row = conn.execute("SELECT id FROM artwork WHERE hash = ?", (digest,)).fetchone()
    if row is not None:
        return int(row["id"])
    return int(
        conn.execute(
            "INSERT INTO artwork (hash, blob, mime) VALUES (?, ?, ?)",
            (digest, data, mime),
        ).lastrowid
    )


class ArtworkStore:
    """Per-scan cache: folder → artwork_id, so a 20-track album folder is
    hashed once. Tracks bytes are hashed then dropped; nothing large is held."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._folder_cache: dict[Path, int | None] = {}

    def reset(self) -> None:
        self._folder_cache.clear()

    def resolve(
        self, path: Path, suffix: str, *, embedded_from: Path | None = None
    ) -> int | None:
        """Artwork id for a track: embedded art first, folder image second.

        `embedded_from` overrides the file probed for embedded art: a repaired
        track's original is unparseable by mutagen, so the probe targets the
        remux in the data dir, while the folder fallback still reads
        `path.parent` (the library folder holds covers, never remuxes)."""
        embedded = None
        try:
            embedded = _extract_embedded(embedded_from or path, suffix)
        except Exception as exc:  # noqa: BLE001 - bad files must not stop the scan
            log.warning(
                "Artwork extraction failed for %s (%s: %s)",
                embedded_from or path, type(exc).__name__, exc,
            )
            log.debug("Artwork extraction traceback", exc_info=True)

        if embedded is not None:
            data, mime = embedded
            return self._store(data, mime)

        folder = path.parent
        if folder not in self._folder_cache:
            self._folder_cache[folder] = self._folder_artwork_id(folder)
        return self._folder_cache[folder]

    def _folder_artwork_id(self, folder: Path) -> int | None:
        try:
            names = {name.lower(): name for name in os.listdir(folder)}
        except OSError:
            return None
        for candidate in FOLDER_ARTWORK_NAMES:
            actual = names.get(candidate)
            if actual is None:
                continue
            try:
                data = (folder / actual).read_bytes()
            except OSError:
                continue
            mime = sniff_mime(data)
            if mime is None:
                continue
            return self._store(data, mime)
        return None

    def _store(self, data: bytes, mime: str) -> int | None:
        if not data:
            return None
        return store_artwork(self._conn, data, mime)


# ---- sized variants -----------------------------------------------------------

# Grid tiles ask for one of these edge lengths; other values snap up to the
# next one (anything larger to the largest), so the cache holds at most
# len(THUMB_SIZES) files per artwork.
THUMB_SIZES = (64, 96, 128, 256, 512)
THUMB_CACHE_DIR = "artwork-cache"
THUMB_TIMEOUT_SECONDS = 15
# ffmpeg renders are CPU-bound; a burst of cold grid tiles shouldn't fan out
# into one process per request.
_thumb_slots = threading.BoundedSemaphore(4)


def snap_size(size: int) -> int:
    return next((s for s in THUMB_SIZES if s >= size), THUMB_SIZES[-1])


def _thumb_name(artwork_id: int, size: int, digest: str) -> str:
    # The content hash makes a reused id (pruned row, new art) a cache miss
    # rather than a stale hit; the id prefix lets a render sweep its own
    # outdated siblings, so re-uploads never accumulate files.
    return f"{artwork_id}-{size}-{digest[:16]}.jpg"


def thumbnail_path(
    cache_dir: Path, artwork_id: int, digest: str, blob: bytes, size: int
) -> Path | None:
    """A cached JPEG at most `size` px on its long edge (never upscaled),
    rendered with ffmpeg on first request. None when ffmpeg is missing or
    can't decode the image — the caller serves the original instead."""
    size = snap_size(size)
    target = cache_dir / _thumb_name(artwork_id, size, digest)
    if target.is_file():
        return target
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return None
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        log.warning("Artwork cache dir %s is not writable", cache_dir, exc_info=True)
        return None
    stem = f".{artwork_id}-{size}-{os.getpid()}-{threading.get_ident()}"
    source, rendered = cache_dir / f"{stem}.src", cache_dir / f"{stem}.tmp"
    try:
        with _thumb_slots:
            source.write_bytes(blob)
            result = subprocess.run(
                [
                    ffmpeg, "-nostdin", "-v", "error", "-y",
                    "-i", str(source),
                    "-vf",
                    f"scale=w='min({size},iw)':h='min({size},ih)'"
                    ":force_original_aspect_ratio=decrease",
                    "-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "3",
                    "-f", "mjpeg", str(rendered),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=THUMB_TIMEOUT_SECONDS,
                check=False,
            )
        if (
            result.returncode != 0
            or not rendered.is_file()
            or sniff_mime(rendered.read_bytes()[:8]) != MIME_JPEG
        ):
            log.debug(
                "Thumbnail render failed for artwork %s: %s",
                artwork_id, result.stderr.decode("utf-8", "replace")[-300:],
            )
            return None
        os.replace(rendered, target)
    except (OSError, subprocess.SubprocessError):
        log.warning("Thumbnail render failed for artwork %s", artwork_id, exc_info=True)
        return None
    finally:
        for leftover in (source, rendered):
            try:
                leftover.unlink()
            except OSError:
                pass
    # Drop this size's renders of older content under the same id.
    for stale in cache_dir.glob(f"{artwork_id}-{size}-*.jpg"):
        if stale != target:
            try:
                stale.unlink()
            except OSError:
                pass
    return target


def prune_thumbnail_cache(conn, cache_dir: Path) -> int:
    """Delete cached renders whose artwork row is gone or whose content
    changed. One directory listing plus one query — run once at startup."""
    if not cache_dir.is_dir():
        return 0
    live = {(str(r["id"]), r["hash"][:16]) for r in conn.execute("SELECT id, hash FROM artwork")}
    removed = 0
    for entry in cache_dir.iterdir():
        name = entry.name
        if name.startswith("."):
            continue  # an in-flight render's temp file
        parts = name.removesuffix(".jpg").split("-", 2)
        if name.endswith(".jpg") and len(parts) == 3 and (parts[0], parts[2]) in live:
            continue
        try:
            entry.unlink()
            removed += 1
        except OSError:
            pass
    return removed
