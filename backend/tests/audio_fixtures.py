"""Hermetic audio fixtures: minimal-but-valid MP3 and FLAC files that mutagen
fully parses. MP3 tags are prepended by mutagen; FLAC tags and pictures are
written on save."""

from __future__ import annotations

import struct
from pathlib import Path

from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TALB, TCON, TIT2, TPE1, TPE2, TPOS, TRCK, TYER

# 128 kbps MPEG-1 Layer III mono frame: 4-byte header + zeroed payload.
_MP3_FRAME = bytes([0xFF, 0xFB, 0x90, 0xC4]) + b"\x00" * 413
_FRAMES_PER_SECOND = 38  # 1152 samples / 44100 Hz ≈ 38.3 frames/s

# MPEG-1 Layer III bitrate-index bits (byte 3, high nibble) for the sizes we use.
_BITRATE_INDEX = {32: 0x10, 64: 0x50, 128: 0x90}


def _mp3_frame(kbps: int) -> bytes:
    """A silent frame at the chosen bitrate: 4-byte header + zeroed payload
    (zero side info = no main data = silence). Frame size is 144·bitrate/
    samplerate; mutagen estimates CBR duration from file size, so lower
    bitrates shrink generated libraries without changing reported lengths."""
    size = 144 * kbps * 1000 // 44100
    return bytes([0xFF, 0xFB, _BITRATE_INDEX[kbps], 0xC4]) + b"\x00" * (size - 4)
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
    genre: str | None = None,
    picture: bytes | None = None,
    kbps: int = 128,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame = _MP3_FRAME if kbps == 128 else _mp3_frame(kbps)
    path.write_bytes(frame * int(seconds * _FRAMES_PER_SECOND))

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
    if genre is not None:
        tags.add(TCON(encoding=3, text=genre))
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
