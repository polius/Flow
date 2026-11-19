"""Dev utility: a library to check gapless playback by ear or by measurement.

One continuous 440 Hz tone, 24 s long, cut at exactly 12 s into two songs,
as FLAC ("Tone FLAC") and as MP3 ("Tone MP3"). Played through in Flow,
part 1 into part 2 must sound like one unbroken tone; any gap is the
player's, since the files themselves join sample for sample.

How the README's figures were measured (19 Nov 2026, Flow's own audio
graph): play part 1 from the start and record what the graph sends to the
speakers (a ScriptProcessor connected beside every node that feeds the
destination), then take the longest near-silent run (|x| < 0.01) around
the 12 s mark. A sine is near zero for a sample or two at a time; anything
longer is a gap. Chrome needs a real (not headless-shell) build to produce
audio.

    python backend/scripts/gapless_library.py --out /tmp/gapless/music

Needs ffmpeg with libmp3lame.
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

RATE = 44100


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)  # noqa: S603, S607


def build(out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tone = Path(tmp) / "tone.wav"
        _ffmpeg("-f", "lavfi", "-i", f"sine=frequency=440:duration=24:sample_rate={RATE}",
                "-af", "volume=0.5", str(tone))
        for fmt, ext, codec in (("FLAC", "flac", []), ("MP3", "mp3", ["-c:a", "libmp3lame", "-b:a", "192k"])):
            folder = out / "Gap Test" / f"Tone {fmt}"
            folder.mkdir(parents=True, exist_ok=True)
            for part in (1, 2):
                _ffmpeg(
                    "-i", str(tone), "-ss", str((part - 1) * 12), "-t", "12", *codec,
                    "-metadata", f"title=Tone Part {part}", "-metadata", "artist=Gap Test",
                    "-metadata", f"album=Tone {fmt}", "-metadata", f"track={part}",
                    str(folder / f"0{part}.{ext}"),
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--out", type=Path, required=True, help="library folder to write into")
    build(parser.parse_args().out)


if __name__ == "__main__":
    main()
