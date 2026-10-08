"""Self-healing scan: rescue playable audio out of mislabeled containers via a lossless remux (originals are never modified)."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.id3 import ID3
from mutagen.mp4 import MP4, MP4Cover

from app import config
from app.artwork import sniff_mime
from app.tags import iso_bmff_offset, parse_audio

log = logging.getLogger("flow.repair")

# Files below this are never attempted: nothing to rescue.
MIN_REPAIR_BYTES = 1024

# Probe is read-only and fast; remux is `-c copy` (stream copy), so even a
# long file is seconds — but a stuck subprocess must never wedge the scan.
FFPROBE_TIMEOUT_S = 60
FFMPEG_TIMEOUT_S = 120

# codec found inside → (extension, ffmpeg muxer). The m4a muxer is "ipod",
# the MPEG-4 audio profile of the mov family.
_CODEC_CONTAINER: dict[str, tuple[str, str]] = {
    "aac": ("m4a", "ipod"),
    "alac": ("m4a", "ipod"),
    "mp3": ("mp3", "mp3"),
    "flac": ("flac", "flac"),
    "vorbis": ("ogg", "ogg"),
    "opus": ("opus", "opus"),
}

# ID3 frames → MP4 atoms (text); track/disc pairs are handled separately.
_MP4_TEXT = {
    "TIT2": "\xa9nam",
    "TPE1": "\xa9ART",
    "TPE2": "aART",
    "TALB": "\xa9alb",
    "TCOM": "\xa9wrt",
    "TCON": "\xa9gen",
    "TDRC": "\xa9day",
    "TYER": "\xa9day",
}

# ID3 frames → Vorbis comment keys (flac/ogg/opus copies).
_VORBIS_TEXT = {
    "TIT2": "title",
    "TPE1": "artist",
    "TPE2": "albumartist",
    "TALB": "album",
    "TCOM": "composer",
    "TCON": "genre",
    "TDRC": "date",
    "TYER": "date",
}


def repair_file(
    rel: str, src: Path, *, mtime: float, size: int
) -> tuple[Path | None, str | None]:
    """Attempt to rescue one unparseable file. Returns (path, detail):
    a verified repaired copy and None; (None, reason) when a repair was
    attempted and failed; (None, None) when no attempt was warranted."""
    if not config.REPAIR or size < MIN_REPAIR_BYTES:
        return None, None
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        return None, None

    out_dir = config.DATA_DIR / "repaired"
    out_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{rel}\0{size}\0{mtime}".encode()).hexdigest()[:20]

    stripped: Path | None = None
    part: Path | None = None
    try:
        # An ISO-BMFF payload behind junk (typically the stream-rip's ID3
        # tag) must be probed from the payload start. The junk is skipped
        # onto a temp copy — the original stays byte-identical.
        offset = iso_bmff_offset(src)
        probe_src = src
        if offset:
            stripped = out_dir / f".{key}.stripped"
            _copy_from_offset(src, stripped, offset)
            probe_src = stripped

        codec = _probe_codec(probe_src)
        container = _CODEC_CONTAINER.get(codec or "")
        if container is None and codec and codec.startswith("pcm_"):
            container = ("wav", "wav")
        if container is None:
            return None, "no decodable audio stream found"
        ext, muxer = container
        out = out_dir / f"{key}.{ext}"

        # An identical repair from an earlier scan (same path+size+mtime →
        # same key) is reused instead of paying ffmpeg again; a copy that
        # no longer verifies is rebuilt from scratch.
        if out.is_file() and _verifies(out):
            return out, None

        part = out.with_suffix(f".{ext}.part")
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [
                "ffmpeg",
                "-v", "error",
                "-nostdin",
                "-i", str(probe_src),
                "-map", "0:a:0",
                "-map_metadata", "-1",
                "-map_chapters", "-1",
                "-c", "copy",
                "-f", muxer,
                "-y", str(part),
            ],
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_S,
        )
        if proc.returncode != 0 or not part.is_file() or part.stat().st_size == 0:
            reason = _stderr_tail(proc.stderr) or "ffmpeg remux failed"
            return None, reason
        _apply_tags(src, part, ext)  # best effort — never fails the repair
        if not _verifies(part):
            return None, "repaired copy still unparseable"
        os.replace(part, out)  # atomic promote; readers never see a half file
        part = None
        log.info("Repaired unparseable file: %s → %s", rel, out.name)
        return out, None
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"ffmpeg failed: {exc}"
    finally:
        for tmp in (stripped, part):
            if tmp is not None:
                try:
                    tmp.unlink()
                except OSError:
                    pass


def _copy_from_offset(src: Path, dst: Path, offset: int) -> None:
    with src.open("rb") as fin, dst.open("wb") as fout:
        fin.seek(offset)
        shutil.copyfileobj(fin, fout)


def _probe_codec(path: Path) -> str | None:
    """The codec of the first audio stream, per ffprobe."""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            "ffprobe",
            "-v", "error",
            "-probesize", "10M",
            "-analyzeduration", "10M",
            "-show_entries", "stream=codec_name,codec_type",
            "-of", "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=FFPROBE_TIMEOUT_S,
    )
    if proc.returncode != 0:
        return None
    try:
        streams = json.loads(proc.stdout or "{}").get("streams", [])
    except ValueError:
        return None
    for stream in streams:
        if stream.get("codec_type") == "audio" and stream.get("codec_name"):
            return str(stream["codec_name"])
    return None


def _verifies(path: Path) -> bool:
    """A repair only counts if the copy parses as real audio with real
    duration — the same gate the original failed."""
    parsed = parse_audio(path)
    return parsed is not None and parsed.duration > 0


def _apply_tags(src: Path, dst: Path, ext: str) -> None:
    """Copy the original's ID3 tag onto the repaired copy. The ID3 area
    parses even when the audio it prefixes does not — this is how stream
    rips keep their real titles instead of filename fallbacks."""
    try:
        tags = ID3(src)
    except Exception:  # noqa: BLE001 - no ID3 tag at all is the common case
        return
    try:
        if ext == "m4a":
            _tags_to_mp4(tags, dst)
        elif ext == "mp3":
            tags.save(str(dst), v2_version=3)
        else:
            _tags_to_vorbis(tags, dst)
    except Exception:  # noqa: BLE001 - metadata is a bonus, never a failure
        log.debug("Tag mapping failed for %s", dst, exc_info=True)


def _tags_to_mp4(tags: ID3, dst: Path) -> None:
    audio = MP4(dst)
    for frame_key, atom in _MP4_TEXT.items():
        frame = tags.get(frame_key)
        if frame and frame.text:
            values = [str(v) for v in frame.text if str(v).strip()]
            if values:
                audio[atom] = values
    trkn = _id3_pair(tags.get("TRCK"))
    if trkn:
        audio["trkn"] = [trkn]
    disk = _id3_pair(tags.get("TPOS"))
    if disk:
        audio["disk"] = [disk]
    # Covers ride along too: the remux strips all metadata, so the APIC
    # frames from the broken original are the only source.
    covers = []
    for apic in tags.getall("APIC"):
        mime = sniff_mime(apic.data)
        if mime is None:
            continue
        covers.append(
            MP4Cover(
                apic.data,
                imageformat=(
                    MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
                ),
            )
        )
    if covers:
        audio["covr"] = covers
    audio.save()


def _tags_to_vorbis(tags: ID3, dst: Path) -> None:
    audio = MutagenFile(str(dst))
    if audio is None or audio.tags is None:
        return
    for frame_key, key in _VORBIS_TEXT.items():
        frame = tags.get(frame_key)
        if frame and frame.text:
            values = [str(v) for v in frame.text if str(v).strip()]
            if values:
                audio.tags[key] = values
    audio.save()


def _id3_pair(frame) -> tuple[int, int] | None:
    """"3/12" → (3, 12); "3" → (3, 0) — the MP4 trkn/disk atom shape."""
    if not frame or not frame.text:
        return None
    head, _, tail = str(frame.text[0]).partition("/")
    try:
        number = int(head.strip())
    except ValueError:
        return None
    try:
        total = int(tail.strip()) if tail.strip() else 0
    except ValueError:
        total = 0
    return (number, max(total, 0))


def _stderr_tail(stderr: str | None) -> str:
    if not stderr:
        return ""
    text = " ".join(stderr.strip().split())  # ffmpeg wraps + repeats lines
    return text[-200:]
