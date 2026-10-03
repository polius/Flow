"""Library scanner: walk, parse, overlay-safe upserts, moves, removals.

Semantics per DESIGN.md §5 and §13:
- `tracks.mtime` is the contract. Unchanged file → row untouched (user edits
  survive by not being touched at all).
- Changed file → tag-derived columns refreshed, except columns flagged in
  `user_edited` (the overlay): the current value IS the overlay.
- Disappeared file + new file with same size+mtime (duration as tiebreaker)
  → move: `path` updated in place. A move must never look like delete+add.
- Removed files → rows deleted; playlist entries cascade; empty albums,
  artists, and unreferenced artwork are pruned.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import IntFlag
from pathlib import Path

from app import config
from app.artwork import ArtworkStore
from app.db import Database
from app.entities import (
    find_or_create_album,
    find_or_create_artist,
    prune_orphans,
    set_track_credits,
    set_track_genres,
)
from app.events import ScanBus
from app.loudness import analyze_file, ffmpeg_available
from app.repair import repair_file
from app.tags import derive_from_filename, parse_audio

log = logging.getLogger("flow.scanner")

MTIME_EPS = 1e-6
DURATION_EPS = 0.05
# Lock hygiene (§lock): the scanner commits PER FILE (and the analysis pass
# per track) so its WAL write-lock windows stay milliseconds wide — a busy
# scan must never starve the queue mirror's 3 s playhead writes into 500s.
# `synchronous=NORMAL` (db.py) keeps those commits cheap.
# The per-file error log persisted with the scan result (§2.8): enough rows
# to see the shape of a bad rip batch, few enough to stay a settings row.
ERROR_LOG_LIMIT = 500


class Edited(IntFlag):
    """Bitmask of user-overridden fields (DESIGN.md §5). The scanner only
    ever preserves these bits; the Get Info editor (M4) sets them."""

    TITLE = 1
    ARTIST = 2
    ALBUM = 4
    TRACK_NO = 8
    ALBUM_ARTIST = 16
    GENRE = 32


@dataclass
class WalkedFile:
    rel: str  # posix-style path relative to the library root (DB identity)
    abs: Path
    mtime: float
    size: int


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _settings_upsert(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


class LibraryScanner:
    def __init__(self, db: Database, music_dir: Path, bus: ScanBus) -> None:
        self._db = db
        self._music = music_dir
        self._bus = bus
        self._lock = threading.Lock()
        self._running = False
        self._state = {
            "state": "idle",
            "phase": None,
            "current": 0,
            "total": 0,
            "errors": 0,
        }
        # Per-file failures of the last scan (path + reason), persisted at
        # finish and served by GET /api/scan/errors (§2.8).
        self._error_log: list[dict] = []

    # ---- public API ------------------------------------------------------

    @property
    def scanning(self) -> bool:
        with self._lock:
            return self._running

    def current_state_event(self) -> dict:
        with self._lock:
            state = dict(self._state)
        conn = self._db.connect()
        row = conn.execute(
            "SELECT key, value FROM settings WHERE key IN "
            "('scan_finished_at', 'scan_mount_guard')"
        ).fetchall()
        persisted = {r["key"]: r["value"] for r in row}
        return {
            "type": "state",
            **state,
            "finished_at": persisted.get("scan_finished_at") or None,
            "mount_guard": persisted.get("scan_mount_guard") == "1",
        }

    def scan_error_log(self) -> dict:
        """The persisted error log of the last scan (§2.8)."""
        conn = self._db.connect()
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'scan_error_log'"
        ).fetchone()
        if row is None:
            return {"total": 0, "truncated": False, "items": []}
        try:
            parsed = json.loads(row["value"])
        except ValueError:
            return {"total": 0, "truncated": False, "items": []}
        return {
            "total": int(parsed.get("total", 0)),
            "truncated": bool(parsed.get("truncated", False)),
            "items": parsed.get("items", []),
        }

    def start_scan(self, trigger: str) -> bool:
        """Kick off a background scan. False if one is already running
        (including the post-scan loudness phase — the index it follows is
        already correct, and the next scan re-runs whatever it missed)."""
        with self._lock:
            if self._running:
                return False
            self._running = True
        thread = threading.Thread(
            target=self._scan_thread, args=(trigger,), name="flow-scan", daemon=True
        )
        thread.start()
        return True

    def run_scan(self, trigger: str) -> None:
        """Synchronous scan — used directly by tests, wrapped by start_scan."""
        self._reconcile(trigger)

    # ---- internals -------------------------------------------------------

    def _scan_thread(self, trigger: str) -> None:
        try:
            self._reconcile(trigger)
            # Sound Check pass (§2.3) — after the index is correct, before
            # the scan reports done. Skips itself when ffmpeg is absent.
            self._analyze_gains()
        except Exception:  # noqa: BLE001 - a scan must never take the app down
            log.exception("Scan crashed")
            try:
                conn = self._db.connect()
                self._set_state(state="idle", phase=None)
                self._persist_finish(conn, errors=self._state["errors"])
                conn.commit()
            except Exception:  # noqa: BLE001
                log.exception("Could not reset scan state after crash")
        finally:
            self._db.close_thread()
            with self._lock:
                self._running = False

    def _set_state(self, **kwargs) -> None:
        with self._lock:
            self._state.update(kwargs)
            state = dict(self._state)
        self._bus.publish({"type": "state", **state})

    # -- reconcile ---------------------------------------------------------

    def _reconcile(self, trigger: str) -> None:
        log.info("Scan started (trigger=%s, root=%s)", trigger, self._music)
        conn = self._db.connect()
        artstore = ArtworkStore(conn)

        files = self._walk()
        db_rows = {
            row["path"]: row
            for row in conn.execute(
                "SELECT id, path, title, artist_id, album_id, album_artist_id, "
                "track_no, mtime, size, duration, media_path, user_edited FROM tracks"
            )
        }

        # Safety guard: a non-empty index against an empty walk is almost
        # always a broken or missing bind mount, not a user action. Removals
        # are irreversible (§5), so refuse to mass-delete and surface it.
        # Resetting a library deliberately = remove the data volume.
        if not files and db_rows:
            log.warning(
                "Library walk found 0 files but the index holds %d tracks — "
                "skipping removals (suspected broken mount)",
                len(db_rows),
            )
            reason = (
                f"Library folder was unreachable — scan skipped removals; "
                f"{len(db_rows)} tracks kept untouched"
            )
            self._error_log = [{"path": "(library root)", "reason": reason}]
            self._set_state(state="idle", phase=None, errors=1)
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('scan_mount_guard', '1') "
                "ON CONFLICT(key) DO UPDATE SET value = '1'"
            )
            self._persist_finish(conn, errors=1)
            conn.commit()
            return
        # A walk that found files proves the mount is back — clear the flag.
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('scan_mount_guard', '0') "
            "ON CONFLICT(key) DO UPDATE SET value = '0'"
        )
        self._error_log = []

        disk = {f.rel: f for f in files}

        disappeared = set(db_rows) - set(disk)
        added = set(disk) - set(db_rows)
        changed = {
            rel
            for rel in set(disk) & set(db_rows)
            if abs(db_rows[rel]["mtime"] - disk[rel].mtime) > MTIME_EPS
        }

        moves = self._match_moves(added, disappeared, disk, db_rows)
        moved_old_paths = {row["path"] for row in moves.values()}

        # A repaired copy deleted out-of-band (data dir cleaned by hand)
        # leaves a track whose stream 404s though its original never
        # changed — reprocess the original so the repair is re-derived.
        lost_copies = {
            rel
            for rel, row in db_rows.items()
            if row["media_path"]
            and rel in disk
            and not Path(row["media_path"]).is_file()
        }
        changed |= lost_copies

        total = len(moves) + len(added) + len(changed) + len(disappeared)
        self._set_state(state="scanning", phase="scan", current=0, total=total, errors=0)
        self._persist_start(conn, total=total)
        conn.commit()

        errors = 0
        processed = 0

        def tick() -> None:
            nonlocal processed
            processed += 1
            self._set_state(state="scanning", current=processed)

        for rel in sorted(moves):
            conn.execute(
                "UPDATE tracks SET path = ? WHERE id = ?", (rel, moves[rel]["id"])
            )
            tick()
            # Lock hygiene (§lock): one tiny transaction per row — the queue
            # mirror's writes land in the gaps instead of piling into 500s.
            conn.commit()

        # Files matched as moves are already handled above — skip them here.
        for rel in sorted(added - set(moves)):
            if not self._upsert_file(conn, artstore, disk[rel], None):
                errors += 1
            tick()
            self._persist_progress(conn, processed, errors)
            conn.commit()

        for rel in sorted(changed):
            if not self._upsert_file(conn, artstore, disk[rel], db_rows[rel]):
                errors += 1
            tick()
            self._persist_progress(conn, processed, errors)
            conn.commit()

        for rel in sorted(disappeared - moved_old_paths):
            # The repaired copy (if any) exists only because this row did.
            stale = db_rows[rel]["media_path"]
            if stale:
                try:
                    Path(stale).unlink()
                except OSError:
                    pass
            conn.execute("DELETE FROM tracks WHERE id = ?", (db_rows[rel]["id"],))
            tick()
            conn.commit()

        prune_orphans(conn)
        self._persist_finish(conn, errors=errors)
        conn.commit()
        artstore.reset()
        self._set_state(
            state="idle", phase=None, current=total, total=total, errors=errors
        )
        log.info(
            "Scan finished (trigger=%s): %d new/changed, %d moves, %d removed, %d errors",
            trigger, len(added) + len(changed), len(moves), len(disappeared), errors,
        )

    # -- classification ----------------------------------------------------

    def _match_moves(
        self,
        added: set[str],
        disappeared: set[str],
        disk: dict[str, WalkedFile],
        db_rows: dict,
    ) -> dict[str, dict]:
        """New path + vanished row with identical size and mtime → move."""
        moves: dict[str, dict] = {}
        vanished = set(disappeared)
        for rel in sorted(added):
            f = disk[rel]
            candidates = [
                old
                for old in vanished
                if db_rows[old]["size"] == f.size
                and abs(db_rows[old]["mtime"] - f.mtime) <= MTIME_EPS
            ]
            if not candidates:
                continue
            if len(candidates) > 1:
                parsed = parse_audio(f.abs)
                if parsed is None:
                    continue
                exact = [
                    old
                    for old in candidates
                    if abs((db_rows[old]["duration"] or 0.0) - parsed.duration) < DURATION_EPS
                ]
                if len(exact) != 1:
                    continue
                candidates = exact
            old = candidates[0]
            vanished.remove(old)
            moves[rel] = db_rows[old]
        return moves

    # -- upserts -----------------------------------------------------------

    def _upsert_file(
        self, conn, artstore: ArtworkStore, f: WalkedFile, existing: dict | None
    ) -> bool:
        """Parse and write one file. Returns False on parse failure. A file
        mutagen cannot read gets one repair attempt (§38): a lossless remux
        of the audio inside, verified before it may enter the index. The
        original is never modified — the row points at the copy via
        media_path, and the copy is re-derived whenever the original
        changes or the copy itself disappears."""
        parsed = parse_audio(f.abs)
        media_path: str | None = None
        detail: str | None = None
        if parsed is None:
            repaired, detail = repair_file(f.rel, f.abs, mtime=f.mtime, size=f.size)
            if repaired is not None:
                parsed = parse_audio(repaired)
                if parsed is not None:
                    media_path = str(repaired)
        if parsed is None:
            # One user-facing line per file already went out from tags.py;
            # the persisted scan error log (§2.8) is the durable record.
            log.debug("Skipping unparseable file: %s", f.rel)
            reason = "Unreadable or unrecognized audio file"
            if detail:
                reason += f" — repair attempted but failed ({detail})"
            self._error_log.append({"path": f.rel, "reason": reason})
            return False

        # The streamed format follows the file that actually plays: a
        # remuxed copy is canonical (m4a for AAC, wav for PCM, …).
        suffix = f.abs.suffix.lower().lstrip(".")
        if media_path:
            suffix = Path(media_path).suffix.lower().lstrip(".")
        edited = Edited(existing["user_edited"]) if existing else Edited(0)
        fallback_track_no, fallback_title = derive_from_filename(f.rel)

        # Overlay semantics: user-edited columns keep their current value —
        # that value IS the overlay. Everything else follows the tags.
        if Edited.TITLE in edited:
            title = existing["title"] if existing else None
        else:
            title = parsed.title or fallback_title

        if Edited.TRACK_NO in edited:
            track_no = existing["track_no"] if existing else None
        else:
            track_no = parsed.track_no if parsed.track_no is not None else fallback_track_no

        if Edited.ARTIST in edited and existing:
            artist_id = existing["artist_id"]
        else:
            artist_id = find_or_create_artist(conn, parsed.artist)

        if Edited.ALBUM_ARTIST in edited and existing:
            # The user pinned this album's compilation semantics (§2.2);
            # their choice outranks the tag on every rescan.
            album_artist_id = existing["album_artist_id"]
        else:
            album_artist_id = find_or_create_artist(
                conn, parsed.album_artist or parsed.artist
            )
        if Edited.ALBUM in edited and existing:
            album_id = existing["album_id"]
        else:
            album_id = find_or_create_album(
                conn, parsed.album, album_artist_id, parsed.year
            )

        # Embedded art must be probed from a file mutagen can parse: a
        # repaired track's original never will (that is why it was repaired),
        # while the remuxed copy may carry mapped cover art (§38). The folder
        # fallback still reads the library folder.
        art_file = Path(media_path) if media_path else f.abs
        artwork_id = artstore.resolve(f.abs, art_file.suffix.lower(), embedded_from=art_file)

        # Album-level facts follow the first track seen (DESIGN.md §5):
        # artwork backfills only when the album has none yet.
        if album_id is not None and artwork_id is not None:
            conn.execute(
                "UPDATE albums SET artwork_id = ? WHERE id = ? AND artwork_id IS NULL",
                (artwork_id, album_id),
            )

        values = {
            "path": f.rel,
            "title": title or f.rel,
            "artist_id": artist_id,
            "album_id": album_id,
            "album_artist_id": album_artist_id,
            "track_no": track_no,
            "disc_no": parsed.disc_no,
            "year": parsed.year,
            "duration": parsed.duration,
            "format": suffix,
            "bitrate": parsed.bitrate,
            "sample_rate": parsed.sample_rate,
            # A tag-provided ReplayGain is the free, exact loudness value
            # (§2.3); otherwise it stays NULL for the analysis phase.
            "gain_db": parsed.replaygain_db,
            "mtime": f.mtime,
            "size": f.size,
            "media_path": media_path,
            "artwork_id": artwork_id,
        }

        if existing:
            # The file was reprocessed: a repair copy it pointed at is now
            # stale (the original healed, changed shape, or re-repaired
            # under a new key) — drop the orphan copy before rewriting.
            stale = existing["media_path"]
            if stale and stale != media_path:
                try:
                    Path(stale).unlink()
                except OSError:
                    pass
            sets = ", ".join(f"{col} = ?" for col in values)
            cur = conn.execute(
                f"UPDATE tracks SET {sets} WHERE id = ?",
                (*values.values(), existing["id"]),
            )
            track_id = existing["id"]
        else:
            columns = ", ".join(values)
            placeholders = ", ".join("?" for _ in values)
            cur = conn.execute(
                f"INSERT INTO tracks ({columns}, user_edited, added_at) "
                f"VALUES ({placeholders}, 0, ?)",
                (*values.values(), _utcnow()),
            )
            track_id = int(cur.lastrowid)

        # Credited artists always follow the tags; the primary display
        # credit follows the (overlay-aware) artist column. Genres follow
        # the tags too — unless the user set one in Organize (§22): their
        # choice is the overlay, so the tag genre never overwrites it.
        set_track_credits(
            conn,
            track_id,
            primary_artist_id=artist_id,
            main=parsed.artists,
            featured=parsed.featured,
            composers=parsed.composers,
        )
        if Edited.GENRE in edited and existing:
            pass  # the user's genre outranks the tag on every rescan
        else:
            set_track_genres(conn, track_id, parsed.genres)
        return True

    # -- walk --------------------------------------------------------------

    def _walk(self) -> list[WalkedFile]:
        out: list[WalkedFile] = []
        for root, dirs, filenames in os.walk(self._music):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for name in sorted(filenames):
                if name.startswith((".", "._")):
                    continue
                if Path(name).suffix.lower() not in config.LIBRARY_EXTENSIONS:
                    continue
                abs_path = Path(root) / name
                try:
                    st = abs_path.stat()
                except OSError:
                    continue
                out.append(
                    WalkedFile(
                        rel=abs_path.relative_to(self._music).as_posix(),
                        abs=abs_path,
                        mtime=st.st_mtime,
                        size=st.st_size,
                    )
                )
        return out

    # -- loudness analysis (§2.3) -------------------------------------------

    def _analyze_gains(self) -> None:
        """Sound Check pass: fill `gain_db` for every track still missing a
        value (new files without ReplayGain tags, and anything scanned
        before ffmpeg was available). Runs under phase="analyze" on the
        scan's own SSE stream; ffmpeg absent → the pass is a no-op and the
        app simply plays at unity gain."""
        if not ffmpeg_available():
            return
        conn = self._db.connect()
        rows = conn.execute(
            "SELECT id, path, media_path FROM tracks WHERE gain_db IS NULL ORDER BY id"
        ).fetchall()
        if not rows:
            return
        total = len(rows)
        log.info("Loudness analysis started (%d tracks)", total)
        self._set_state(state="scanning", phase="analyze", current=0, total=total)
        _settings_upsert(conn, "scan_total", str(total))
        _settings_upsert(conn, "scan_current", "0")
        conn.commit()
        processed = 0
        analyzed = 0
        for row in rows:
            # Repaired tracks analyze their remuxed copy — the original's
            # bytes are what mutagen refused in the first place (§38).
            source = (
                Path(row["media_path"])
                if row["media_path"]
                else self._music / row["path"]
            )
            gain = analyze_file(source)
            # Lock hygiene (§lock): the write transaction opens at the UPDATE
            # below and ends at the commit — ffmpeg NEVER runs inside one.
            # A transaction held across ~25 analyses (the old batching) kept
            # the WAL write lock for minutes and 500'd the queue mirror.
            if gain is not None:
                conn.execute(
                    "UPDATE tracks SET gain_db = ? WHERE id = ?", (gain, row["id"])
                )
                analyzed += 1
            processed += 1
            self._set_state(state="scanning", phase="analyze", current=processed)
            if processed % 25 == 0:
                _settings_upsert(conn, "scan_current", str(processed))
            conn.commit()
        log.info("Loudness analysis finished (%d/%d measured)", analyzed, total)
        # The scan is only done when the UI says so: re-publish idle (the
        # reconcile phase published its own idle before this pass ran).
        errors = self._state["errors"]
        self._persist_finish(conn, errors=errors)
        conn.commit()
        self._set_state(state="idle", phase=None, current=total, total=total, errors=errors)

    # -- settings persistence (reload shows scan state, DESIGN.md §6) ------

    def _persist_start(self, conn, total: int) -> None:
        _settings_upsert(conn, "scan_state", "scanning")
        _settings_upsert(conn, "scan_total", str(total))
        _settings_upsert(conn, "scan_current", "0")
        _settings_upsert(conn, "scan_errors", "0")
        _settings_upsert(conn, "scan_finished_at", "")

    def _persist_progress(self, conn, current: int, errors: int) -> None:
        _settings_upsert(conn, "scan_current", str(current))
        _settings_upsert(conn, "scan_errors", str(errors))

    def _persist_finish(self, conn, errors: int) -> None:
        _settings_upsert(conn, "scan_state", "idle")
        _settings_upsert(conn, "scan_finished_at", _utcnow())
        _settings_upsert(conn, "scan_errors", str(errors))
        # The error disclosure (§2.8): path + reason for every skipped file,
        # capped so a catastrophically bad mount can't grow a settings row
        # without bound. `total` keeps the honest count either way.
        logged = len(self._error_log)
        payload = {
            "total": logged,
            "truncated": logged > ERROR_LOG_LIMIT,
            "items": self._error_log[:ERROR_LOG_LIMIT],
        }
        _settings_upsert(conn, "scan_error_log", json.dumps(payload))
