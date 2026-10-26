"""Self-healing scan: rescue playable audio out of mislabeled containers via a lossless remux (originals are never modified)."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TXXX, Frames
from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm

from app import config
from app.artwork import sniff_mime
from app.tags import ParsedTags, embedded_picture, parse_audio, sniff_container

log = logging.getLogger("flow.repair")

# Files below this are never attempted: nothing to rescue.
MIN_REPAIR_BYTES = 1024

# Probe is read-only and fast; remux is `-c copy` (stream copy), so even a
# long file is seconds — but a stuck subprocess must never wedge the scan.
FFPROBE_TIMEOUT_S = 60
FFMPEG_TIMEOUT_S = 120

# Bump when detection or remuxing improves: failure markers written by an
# older pipeline are then ignored, so known failures get one fresh attempt.
REPAIR_VERSION = 2

# A copy shorter than this share of the source's declared duration is a
# partial recovery: indexed anyway (some audio beats none), but reported.
PARTIAL_RATIO = 0.98

# codec found inside → (extension, ffmpeg muxer, audio codec). The m4a muxer
# is "ipod", the MPEG-4 audio profile of the mov family. ALAC is the one
# re-encode: only Safari decodes it, and FLAC is just as lossless.
_CODEC_CONTAINER: dict[str, tuple[str, str, str]] = {
    "aac": ("m4a", "ipod", "copy"),
    "alac": ("flac", "flac", "flac"),
    "mp3": ("mp3", "mp3", "copy"),
    "flac": ("flac", "flac", "copy"),
    "vorbis": ("ogg", "ogg", "copy"),
    "opus": ("opus", "opus", "copy"),
}

# WAV holds little-endian PCM only: AIFF's big-endian samples (and AIFF's
# signed 8-bit) become the matching WAV codec — a byte swap, still lossless.
_WAV_PCM: dict[str, str] = {
    "pcm_s16be": "pcm_s16le",
    "pcm_s24be": "pcm_s24le",
    "pcm_s32be": "pcm_s32le",
    "pcm_f32be": "pcm_f32le",
    "pcm_f64be": "pcm_f64le",
    "pcm_s8": "pcm_u8",
}

# Demuxers whose duration is an estimate from the bitrate, not a declared
# length: comparing a copy against it would invent partial recoveries.
_ESTIMATED_DURATION_FORMATS = frozenset({"aac", "mp3"})

# Files this module writes into DATA_DIR/repaired — the only names the
# end-of-scan sweep may ever delete.
_COPY_RE = re.compile(r"^[0-9a-f]{20}\.(?:m4a|mp3|flac|ogg|opus|wav)$")
_TEMP_RE = re.compile(r"^(?:\.[0-9a-f]{20}\.stripped|[0-9a-f]{20}\.\w+\.part)$")
_FAILED_RE = re.compile(r"^([0-9a-f]{20})\.failed$")


@dataclass
class RepairResult:
    """`path` = a verified copy (`parsed` = its tags, so the scanner needn't
    read it again); else `detail` says why the attempt failed (both None =
    no attempt was warranted). `note` flags a copy that plays but holds
    less audio than the source declared."""

    path: Path | None = None
    detail: str | None = None
    note: str | None = None
    parsed: ParsedTags | None = None


def repaired_dir() -> Path:
    return config.DATA_DIR / "repaired"


def repair_key(rel: str, size: int, mtime: float) -> str:
    """A copy's identity: the original's path + size + mtime. Unchanged
    since v1.5.0, so copies made by earlier releases keep matching."""
    return hashlib.sha1(f"{rel}\0{size}\0{mtime}".encode()).hexdigest()[:20]


def known_failure(rel: str, size: int, mtime: float) -> str | None:
    """The recorded reason when this exact file (same path, size, mtime)
    already failed a repair under the current pipeline — such files are
    not re-probed on every scan."""
    marker = repaired_dir() / f"{repair_key(rel, size, mtime)}.failed"
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("v") != REPAIR_VERSION:
        return None
    return str(data.get("reason") or "repair failed")


def repair_file(
    rel: str, src: Path, *, mtime: float, size: int, retry: bool = False
) -> RepairResult:
    """Attempt to rescue one file mutagen refused (or parsed as something
    browsers can't play). Never touches `src`. `retry` (a forced full
    rescan) ignores a recorded failure and rebuilds even a good copy."""
    if not config.REPAIR or size < MIN_REPAIR_BYTES:
        return RepairResult()
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        return RepairResult()

    out_dir = repaired_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    key = repair_key(rel, size, mtime)
    failed_marker = out_dir / f"{key}.failed"
    if not retry:
        reason = known_failure(rel, size, mtime)
        if reason is not None:
            return RepairResult(detail=reason)

    # An identical repair from an earlier scan (same path+size+mtime → same
    # key, whatever release made it) is reused instead of paying ffmpeg
    # again; a copy that no longer verifies is rebuilt from scratch. A
    # forced full rescan rebuilds even a good copy — the pipeline may have
    # improved since it was made — and keeps the old one only when the
    # rebuild fails: a full rescan never loses a track that played.
    kept = _existing_copy(out_dir, key)
    if kept is not None and not retry:
        return kept
    result = _remux(rel, src, out_dir, key, failed_marker)
    if result.path is None and kept is not None and kept.path is not None:
        # The marker _remux may have written would hide the working copy
        # from the next ordinary scan.
        _discard(failed_marker)
        log.warning("Rebuild failed, keeping the earlier copy: %s (%s)", rel, result.detail)
        return kept
    return result


def _existing_copy(out_dir: Path, key: str) -> RepairResult | None:
    for existing in sorted(out_dir.glob(f"{key}.*")):
        if _COPY_RE.match(existing.name):
            parsed = _verified(existing)
            if parsed is not None:
                return RepairResult(path=existing, parsed=parsed)
    return None


def _remux(rel: str, src: Path, out_dir: Path, key: str, failed_marker: Path) -> RepairResult:
    """One fresh repair: probe the payload, remux it to a temp file, verify
    it, then promote it atomically over any earlier copy of the same name."""
    stripped: Path | None = None
    part: Path | None = None
    try:
        # The payload starts past the ID3v2 tags (or past junk in front of
        # an MP4): it is probed and remuxed from exactly there, on a temp
        # copy — the original stays byte-identical.
        sniffed = sniff_container(src)
        probe_src = src
        if sniffed is not None and sniffed.offset > 0:
            stripped = out_dir / f".{key}.stripped"
            _copy_from_offset(src, stripped, sniffed.offset)
            probe_src = stripped

        probe = _probe(probe_src)
        target = _target_for(probe.codec)
        if target is None:
            return _failed(failed_marker, "no decodable audio stream found")
        ext, muxer, codec = target
        out = out_dir / f"{key}.{ext}"

        part = out.with_suffix(f".{ext}.part")
        argv = [
            "ffmpeg",
            "-v", "error",
            "-nostdin",
            "-i", str(probe_src),
            "-map", "0:a:0",
            # The payload's own tags ride along (an MP4's atoms, Ogg/FLAC
            # comments); the ID3 prefix is overlaid on top afterwards.
            "-map_metadata", "0",
            "-map_chapters", "-1",
            "-c:a", codec,
        ]
        if muxer == "ipod":
            # moov up front: browsers start playback without a Range
            # round trip to the end of the file.
            argv += ["-movflags", "+faststart"]
        argv += ["-f", muxer, "-y", str(part)]
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            argv, capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_S
        )
        if proc.returncode != 0 or not part.is_file() or part.stat().st_size == 0:
            reason = _stderr_tail(proc.stderr) or "ffmpeg remux failed"
            return _failed(failed_marker, reason)
        _apply_tags(src, probe_src, part, ext)  # best effort — never fails the repair
        parsed = _verified(part)
        if parsed is None:
            return _failed(failed_marker, "repaired copy still unparseable")
        os.replace(part, out)  # atomic promote; readers never see a half file
        part = None
        _discard(failed_marker)
        log.info("Repaired unparseable file: %s → %s", rel, out.name)
        note = None
        if probe.duration and parsed.duration < probe.duration * PARTIAL_RATIO:
            note = f"recovered {parsed.duration:.1f} of {probe.duration:.1f} s"
            log.warning("Partial recovery: %s — %s", rel, note)
        return RepairResult(path=out, note=note, parsed=parsed)
    except (OSError, subprocess.TimeoutExpired) as exc:
        # Transient by nature (I/O, a slow disk): no failure marker.
        return RepairResult(detail=f"ffmpeg failed: {exc}")
    finally:
        for tmp in (stripped, part):
            if tmp is not None:
                _discard(tmp)


def sweep(referenced: set[str], live_failures: set[str]) -> int:
    """End-of-scan cleanup of DATA_DIR/repaired: copies no row references
    (a crash between promote and commit, a vanished original), temp files a
    SIGKILL/OOM left behind, and failure markers for files that changed or
    disappeared. `referenced` = copy file names in use; `live_failures` =
    keys of files that are still unindexed. Only names this module writes
    are ever touched. Returns the number of files removed."""
    out_dir = repaired_dir()
    try:
        entries = list(out_dir.iterdir())
    except OSError:
        return 0
    removed = 0
    for entry in entries:
        name = entry.name
        failed = _FAILED_RE.match(name)
        if _COPY_RE.match(name):
            stale = name not in referenced
        elif failed:
            stale = failed.group(1) not in live_failures
        else:
            stale = bool(_TEMP_RE.match(name))
        if stale and entry.is_file():
            try:
                entry.unlink()
                removed += 1
            except OSError:
                pass
    if removed:
        log.info("Repair sweep removed %d stale file(s) from %s", removed, out_dir)
    return removed


# ---- internals -------------------------------------------------------------


@dataclass
class _Probe:
    codec: str | None = None
    duration: float | None = None  # declared source length; None = unknown


def _target_for(codec: str | None) -> tuple[str, str, str] | None:
    if not codec:
        return None
    if codec in _CODEC_CONTAINER:
        return _CODEC_CONTAINER[codec]
    if codec.startswith("pcm_"):
        return ("wav", "wav", _WAV_PCM.get(codec, "copy"))
    return None


def _failed(marker: Path, reason: str) -> RepairResult:
    """A deterministic failure: remember it, so the same bytes aren't
    re-probed on every scan (a changed file has a new key)."""
    try:
        marker.write_text(
            json.dumps({"v": REPAIR_VERSION, "reason": reason}), encoding="utf-8"
        )
    except OSError:
        pass
    return RepairResult(detail=reason)


def _discard(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def _copy_from_offset(src: Path, dst: Path, offset: int) -> None:
    with src.open("rb") as fin, dst.open("wb") as fout:
        fin.seek(offset)
        shutil.copyfileobj(fin, fout)


def _probe(path: Path) -> _Probe:
    """The first audio stream's codec and the declared source duration, per
    ffprobe (the container's own header — a truncated file still declares
    its full length, which is how a partial recovery is spotted)."""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            "ffprobe",
            "-v", "error",
            "-probesize", "10M",
            "-analyzeduration", "10M",
            "-show_entries",
            "stream=codec_name,codec_type,duration:format=format_name,duration",
            "-of", "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=FFPROBE_TIMEOUT_S,
    )
    if proc.returncode != 0:
        return _Probe()
    try:
        data = json.loads(proc.stdout or "{}")
    except ValueError:
        return _Probe()
    fmt = data.get("format") or {}
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "audio" and stream.get("codec_name"):
            duration = None
            if str(fmt.get("format_name", "")) not in _ESTIMATED_DURATION_FORMATS:
                duration = _float(stream.get("duration")) or _float(fmt.get("duration"))
            return _Probe(codec=str(stream["codec_name"]), duration=duration)
    return _Probe()


def _float(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _verified(path: Path) -> ParsedTags | None:
    """A repair only counts if the copy parses as real, browser-playable
    audio with real duration — the same gate the original failed."""
    parsed = parse_audio(path)
    if parsed is None or parsed.duration <= 0 or not parsed.playable:
        return None
    return parsed


# ---- metadata overlay ------------------------------------------------------
# Tags travel in one neutral shape: Vorbis-style keys → values, plus one
# cover. Sources: the payload's own tags (read with mutagen; ffmpeg's
# -map_metadata already carried most of them) with the ID3 prefix overlaid
# on top, since that is what the ripper wrote last. Then written in the
# copy's native flavor.

_TEXT_KEYS = (
    "title", "artist", "albumartist", "album", "composer", "genre", "date",
    "tracknumber", "discnumber", "compilation",
)
_REPLAYGAIN_KEYS = (
    "replaygain_track_gain", "replaygain_track_peak",
    "replaygain_album_gain", "replaygain_album_peak",
)

_ID3_FRAMES = {
    "title": "TIT2",
    "artist": "TPE1",
    "albumartist": "TPE2",
    "album": "TALB",
    "composer": "TCOM",
    "genre": "TCON",
    "date": "TDRC",
    "tracknumber": "TRCK",
    "discnumber": "TPOS",
    "compilation": "TCMP",
}

_MP4_ATOMS = {
    "title": "\xa9nam",
    "artist": "\xa9ART",
    "albumartist": "aART",
    "album": "\xa9alb",
    "composer": "\xa9wrt",
    "genre": "\xa9gen",
    "date": "\xa9day",
}
_MP4_FREEFORM = "----:com.apple.iTunes:"


@dataclass
class _Meta:
    text: dict[str, list[str]] = field(default_factory=dict)
    picture: tuple[bytes, str] | None = None

    def overlay(self, other: _Meta) -> _Meta:
        return _Meta({**self.text, **other.text}, other.picture or self.picture)


def _apply_tags(src: Path, payload: Path, dst: Path, ext: str) -> None:
    """Carry the original's metadata onto the repaired copy: the payload's
    own tags and cover (ffmpeg drops cover streams), then the ID3 prefix —
    which parses even when the audio behind it does not. Track/disc,
    ReplayGain and the cover are written per container."""
    try:
        meta = _meta_from_file(payload)
        prefix = _meta_from_id3_prefix(src)
        if prefix is not None:
            meta = meta.overlay(prefix)
        if not meta.text and meta.picture is None:
            return
        if ext == "m4a":
            _write_mp4(meta, dst)
        elif ext in ("mp3", "wav"):
            _write_id3(meta, dst, ext)
        else:
            _write_vorbis(meta, dst)
    except Exception:  # noqa: BLE001 - metadata is a bonus, never a failure
        log.debug("Tag mapping failed for %s", dst, exc_info=True)


def _meta_from_id3_prefix(src: Path) -> _Meta | None:
    try:
        tags = ID3(src)
    except Exception:  # noqa: BLE001 - no ID3 tag at all is the common case
        return None
    return _meta_from_id3(tags)


def _meta_from_id3(tags: ID3) -> _Meta:
    meta = _Meta()
    for key, frame_id in _ID3_FRAMES.items():
        frame = tags.get(frame_id) or (tags.get("TYER") if key == "date" else None)
        if frame is not None and getattr(frame, "text", None):
            values = [str(v) for v in frame.text if str(v).strip()]
            if values:
                meta.text[key] = values
    for frame in tags.getall("TXXX"):
        desc = str(getattr(frame, "desc", "")).strip().lower()
        if desc in _REPLAYGAIN_KEYS and frame.text:
            meta.text[desc] = [str(frame.text[0])]
    apics = sorted(tags.getall("APIC"), key=lambda a: 0 if a.type == 3 else 1)
    meta.picture = _first_image([a.data for a in apics])
    return meta


def _meta_from_file(path: Path) -> _Meta:
    """The tags a payload carries in its own container flavor."""
    try:
        audio = MutagenFile(str(path), easy=False)
    except Exception:  # noqa: BLE001 - unreadable here is fine; ffmpeg copied what it could
        return _Meta()
    if audio is None:
        return _Meta()
    picture = embedded_picture(audio)
    tags = audio.tags
    if tags is None:
        return _Meta(picture=picture)
    if isinstance(tags, ID3):
        meta = _meta_from_id3(tags)
        meta.picture = picture
        return meta
    meta = _Meta(picture=picture)
    if isinstance(audio, MP4):
        for key, atom in _MP4_ATOMS.items():
            values = [str(v) for v in tags.get(atom) or [] if str(v).strip()]
            if values:
                meta.text[key] = values
        for key, atom in (("tracknumber", "trkn"), ("discnumber", "disk")):
            pair = (tags.get(atom) or [None])[0]
            if pair and pair[0]:
                meta.text[key] = [f"{pair[0]}/{pair[1]}" if pair[1] else str(pair[0])]
        if (tags.get("cpil") or [False])[0]:
            meta.text["compilation"] = ["1"]
        for key in _REPLAYGAIN_KEYS:
            values = tags.get(_MP4_FREEFORM + key.upper())
            if values:
                meta.text[key] = [bytes(values[0]).decode("utf-8", "replace")]
        return meta
    for key in (*_TEXT_KEYS, *_REPLAYGAIN_KEYS):
        values = [str(v) for v in tags.get(key) or [] if str(v).strip()]
        if values:
            meta.text[key] = values
    return meta


def _first_image(blobs: list[bytes]) -> tuple[bytes, str] | None:
    for data in blobs:
        mime = sniff_mime(data) if data else None
        if mime is not None:
            return data, mime
    return None


def _pair(value: str) -> tuple[int, int] | None:
    """"3/12" → (3, 12); "3" → (3, 0) — the MP4 trkn/disk atom shape."""
    head, _, tail = value.partition("/")
    try:
        number = int(head.strip())
    except ValueError:
        return None
    try:
        total = int(tail.strip()) if tail.strip() else 0
    except ValueError:
        total = 0
    return (number, max(total, 0))


def _write_mp4(meta: _Meta, dst: Path) -> None:
    audio = MP4(dst)
    if audio.tags is None:
        audio.add_tags()
    for key, atom in _MP4_ATOMS.items():
        if key in meta.text:
            audio[atom] = meta.text[key]
    for key, atom in (("tracknumber", "trkn"), ("discnumber", "disk")):
        pair = _pair(meta.text.get(key, [""])[0])
        if pair:
            audio[atom] = [pair]
    if "compilation" in meta.text:
        audio["cpil"] = meta.text["compilation"][0].strip() in {"1", "true", "yes"}
    for key in _REPLAYGAIN_KEYS:
        if key in meta.text:
            audio[_MP4_FREEFORM + key.upper()] = [
                MP4FreeForm(meta.text[key][0].encode("utf-8"))
            ]
    if meta.picture is not None:
        data, mime = meta.picture
        audio["covr"] = [
            MP4Cover(
                data,
                imageformat=(
                    MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
                ),
            )
        ]
    audio.save()


def _write_id3(meta: _Meta, dst: Path, ext: str) -> None:
    audio = MutagenFile(str(dst))
    if audio is None:
        return
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags
    for key, frame_id in _ID3_FRAMES.items():
        if key in meta.text:
            tags.setall(frame_id, [Frames[frame_id](encoding=3, text=meta.text[key])])
    for key in _REPLAYGAIN_KEYS:
        if key in meta.text:
            tags.setall(
                f"TXXX:{key.upper()}",
                [TXXX(encoding=3, desc=key.upper(), text=meta.text[key])],
            )
    if meta.picture is not None:
        data, mime = meta.picture
        tags.setall("APIC", [APIC(encoding=3, mime=mime, type=3, desc="", data=data)])
    if ext == "mp3":
        audio.save(v2_version=3)
    else:
        audio.save()


def _write_vorbis(meta: _Meta, dst: Path) -> None:
    audio = MutagenFile(str(dst))
    if audio is None:
        return
    if audio.tags is None:
        audio.add_tags()
    for key, values in meta.text.items():
        audio.tags[key] = values
    if meta.picture is not None:
        data, mime = meta.picture
        picture = Picture()
        picture.type = 3  # front cover
        picture.mime = mime
        picture.data = data
        if isinstance(audio, FLAC):
            audio.clear_pictures()
            audio.add_picture(picture)
        else:
            audio.tags["metadata_block_picture"] = [
                base64.b64encode(picture.write()).decode("ascii")
            ]
    audio.save()


def _stderr_tail(stderr: str | None) -> str:
    if not stderr:
        return ""
    text = " ".join(stderr.strip().split())  # ffmpeg wraps + repeats lines
    return text[-200:]
