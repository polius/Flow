"""Hermetic audio fixtures: minimal-but-valid MP3 and FLAC files that mutagen
fully parses. MP3 = raw MPEG-1 Layer III frames (128 kbps, 44.1 kHz) with an
ID3v2 tag prepended by mutagen. FLAC = handcrafted STREAMINFO block; mutagen
writes the Vorbis comments and pictures on save."""

from __future__ import annotations

import struct
from pathlib import Path

from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, TPE2, TPOS, TRCK, TYER

# 128 kbps MPEG-1 Layer III mono frame: 4-byte header + zeroed payload.
_MP3_FRAME = bytes([0xFF, 0xFB, 0x90, 0xC4]) + b"\x00" * 413
_FRAMES_PER_SECOND = 38  # 1152 samples / 44100 Hz ≈ 38.3 frames/s
_JPEG_MAGIC = b"\xff\xd8\xff" + b"\x00" * 64 + b"\xff\xd9"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def jpeg_bytes() -> bytes:
    return _JPEG_MAGIC


def png_bytes() -> bytes:
    return _PNG_MAGIC


def make_mp3(
    path: Path,
    *,
    seconds: float = 5.0,
    title: str | None = None,
    artist: str | None = None,
    albumartist: str | None = None,
    album: str | None = None,
    track: str | None = None,
    disc: str | None = None,
    year: str | None = None,
    picture: bytes | None = None,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_MP3_FRAME * int(seconds * _FRAMES_PER_SECOND))

    tags = ID3()
    if title is not None:
        tags.add(TIT2(encoding=3, text=title))
    if artist is not None:
        tags.add(TPE1(encoding=3, text=artist))
    if albumartist is not None:
        tags.add(TPE2(encoding=3, text=albumartist))
    if album is not None:
        tags.add(TALB(encoding=3, text=album))
    if track is not None:
        tags.add(TRCK(encoding=3, text=track))
    if disc is not None:
        tags.add(TPOS(encoding=3, text=disc))
    if year is not None:
        tags.add(TYER(encoding=3, text=year))
    if picture is not None:
        tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=picture))
    tags.save(str(path), v2_version=3)
    return path


def make_flac(
    path: Path,
    *,
    seconds: float = 5.0,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    picture: bytes | None = None,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)

    sample_rate, channels, bits = 44100, 2, 16
    total_samples = int(sample_rate * seconds)
    packed = (
        (sample_rate << 44) | ((channels - 1) << 41) | ((bits - 1) << 36) | total_samples
    ).to_bytes(8, "big")
    streaminfo = (
        (4096).to_bytes(2, "big")
        + (4096).to_bytes(2, "big")
        + (0).to_bytes(3, "big")
        + (0).to_bytes(3, "big")
        + packed
        + b"\x00" * 16  # md5 — not verified on load
    )
    # fLaC magic + metadata block header (last-block flag | type 0) + body.
    path.write_bytes(
        b"fLaC"
        + bytes([0x80]) + struct.pack(">I", len(streaminfo))[1:]
        + streaminfo
    )

    flac = FLAC(str(path))
    if title is not None:
        flac["title"] = [title]
    if artist is not None:
        flac["artist"] = [artist]
    if album is not None:
        flac["album"] = [album]
    if picture is not None:
        pic = Picture()
        pic.type = 3  # front cover
        pic.mime = "image/png"
        pic.data = picture
        flac.add_picture(pic)
    flac.save()
    return path
