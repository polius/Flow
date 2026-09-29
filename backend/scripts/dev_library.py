"""Dev utility: generate a realistic scratch library for browser testing
(DESIGN.md §15 dev notes, §11.6 virtualization checks).

Structure: ~20 tracks per album, ~25 albums per artist; per-album artwork
dedupes by sha1 as in production. Covers are REAL PNGs (stdlib zlib+struct —
the audio_fixtures art bytes are sniffed fine by the backend but won't render
in <img>), and every 7th album skips embedded art in favor of a sidecar
cover.png to exercise the §13.3 folder fallback.

Usage (from backend/):
    .venv/bin/python scripts/dev_library.py --out /tmp/flow-music --tracks 10000
"""

from __future__ import annotations

import argparse
import colorsys
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.audio_fixtures import make_mp3  # noqa: E402

TRACKS_PER_ALBUM = 20
ALBUMS_PER_ARTIST = 25
COVER_SIZE = 96

DECADES = [1965, 1972, 1977, 1983, 1988, 1991, 1994, 1998, 2003, 2008, 2013, 2019, 2024]


def _chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def real_png(width: int, height: int, pixel) -> bytes:
    """A renderable truecolor PNG. `pixel(x, y) -> (r, g, b)`."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: none
        for x in range(width):
            raw.extend(pixel(x, y))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def album_cover(index: int) -> bytes:
    """Distinct two-tone gradient per album — the only color in the UI (§8.1)."""
    hue = (index * 0.618) % 1.0  # golden-ratio spread avoids near-duplicates
    top = tuple(round(c * 255) for c in colorsys.hls_to_rgb(hue, 0.42, 0.72))
    bottom = tuple(round(c * 255) for c in colorsys.hls_to_rgb(hue, 0.18, 0.55))

    def pixel(x: int, y: int) -> tuple[int, int, int]:
        t = y / (COVER_SIZE - 1)
        return tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))  # type: ignore[return-value]

    return real_png(COVER_SIZE, COVER_SIZE, pixel)


def generate(out: Path, tracks: int, seconds: float) -> None:
    albums = max(1, -(-tracks // TRACKS_PER_ALBUM))
    artists = max(1, -(-albums // ALBUMS_PER_ARTIST))
    print(f"Generating {artists} artists × albums → ~{albums * TRACKS_PER_ALBUM} tracks in {out}")

    made = 0
    for a in range(albums):
        artist = f"Artist {(a // ALBUMS_PER_ARTIST) + 1:02d}"
        album = f"Album {(a % ALBUMS_PER_ARTIST) + 1:02d}"
        album_dir = out / artist / album
        year = DECADES[a % len(DECADES)]
        sidecar = a % 7 == 3  # every 7th album: folder-fallback artwork (§13.3)
        art = None if sidecar else album_cover(a)

        for t in range(TRACKS_PER_ALBUM):
            make_mp3(
                album_dir / f"{t + 1:02d} - Track {t + 1:02d}.mp3",
                title=f"Track {t + 1:02d}",
                artist=artist,
                albumartist=artist,
                album=album,
                track=f"{t + 1}/{TRACKS_PER_ALBUM}",
                disc="1/1",
                year=str(year),
                seconds=seconds,
                picture=art,
            )
            made += 1
        if sidecar:
            (album_dir / "cover.png").write_bytes(album_cover(a))

        if (a + 1) % 50 == 0:
            print(f"  {made} tracks…")

    print(f"Done: {made} tracks, {albums} albums, {artists} artists.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True, help="Library root to create")
    ap.add_argument("--tracks", type=int, default=10_000, help="Approximate track count")
    ap.add_argument("--seconds", type=float, default=1.0, help="Duration of each fixture track")
    args = ap.parse_args()
    if args.out.exists() and any(args.out.iterdir()):
        ap.error(f"{args.out} exists and is not empty")
    args.out.mkdir(parents=True, exist_ok=True)
    generate(args.out, args.tracks, args.seconds)


if __name__ == "__main__":
    main()
