"""Artwork handling: extraction from tags, folder fallback, sha1 dedup.

Rules (DESIGN.md §13.3): embedded art first; fallback to cover/folder/front
images in the track's directory; blobs stored as original bytes, never
re-encoded.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import sqlite3
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


def sniff_mime(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return MIME_JPEG
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return MIME_PNG
    return None


def _extract_embedded(path: Path, suffix: str) -> tuple[bytes, str] | None:
    """Return (image_bytes, mime) from the file's tags, or None."""
    audio = MutagenFile(str(path), easy=False)
    if audio is None or audio.tags is None:
        return None

    if suffix == ".mp3" and isinstance(audio.tags, ID3):
        # Prefer front cover (picture type 3), fall back to the first image.
        apics = audio.tags.getall("APIC")
        for apic in apics:
            if getattr(apic, "type", None) is not None and apic.type == 3:
                return apic.data, sniff_mime(apic.data) or apic.mime
        if apics:
            return apics[0].data, sniff_mime(apics[0].data) or apics[0].mime
        return None

    if suffix == ".flac" and isinstance(audio, FLAC):
        if audio.pictures:
            front = next((p for p in audio.pictures if p.type == 3), audio.pictures[0])
            return front.data, sniff_mime(front.data) or front.mime
        return None

    if suffix == ".m4a" and isinstance(audio, MP4):
        covers = audio.tags.get("covr") if audio.tags else None
        if covers:
            data = bytes(covers[0])
            mime = sniff_mime(data) or (
                MIME_PNG if getattr(covers[0], "imageformat", None) == MP4.FORMAT_PNG else MIME_JPEG
            )
            return data, mime
        return None

    # Ogg Vorbis / Ogg FLAC: pictures ride in a base64 metadata_block_picture
    # comment (the FLAC-picture convention).
    block = audio.tags.get("metadata_block_picture") if audio.tags else None
    if block:
        try:
            picture = Picture(base64.b64decode(block[0]))
            return picture.data, sniff_mime(picture.data) or picture.mime
        except Exception:  # noqa: BLE001 - malformed picture is not fatal
            log.debug("Unreadable metadata_block_picture in %s", path, exc_info=True)
    return None


class ArtworkStore:
    """Per-scan cache: folder → artwork_id, so a 20-track album folder is
    hashed once. Tracks bytes are hashed then dropped; nothing large is held."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._folder_cache: dict[Path, int | None] = {}

    def reset(self) -> None:
        self._folder_cache.clear()

    def resolve(self, path: Path, suffix: str) -> int | None:
        """Artwork id for a track: embedded art first, folder image second."""
        embedded = None
        try:
            embedded = _extract_embedded(path, suffix)
        except Exception:  # noqa: BLE001 - bad tags must not stop the scan
            log.warning("Artwork extraction failed for %s", path, exc_info=True)

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
        digest = hashlib.sha1(data).hexdigest()
        row = self._conn.execute("SELECT id FROM artwork WHERE hash = ?", (digest,)).fetchone()
        if row:
            return row["id"]
        cur = self._conn.execute(
            "INSERT INTO artwork (hash, blob, mime) VALUES (?, ?, ?)",
            (digest, data, mime),
        )
        return int(cur.lastrowid)
