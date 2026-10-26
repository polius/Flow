"""Library scanner: walk, parse, overlay-safe upserts, moves, removals (`tracks.mtime` + `size` are the change contract)."""

from __future__ import annotations

import errno
import json
import logging
import os
import posixpath
import re
import stat
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import IntFlag
from pathlib import Path

from app import config
from app.artwork import FOLDER_ARTWORK_NAMES, ArtworkStore
from app.db import Database
from app.entities import (
    backfill_name_keys,
    find_or_create_album,
    find_or_create_artist,
    prune_orphans,
    set_track_credits,
    set_track_genres,
)
from app.events import ScanBus
from app.loudness import analyze_file, ffmpeg_available, gain_from_replaygain
from app.repair import repair_file, repair_key, sweep
from app.tags import ParsedTags, derive_from_filename, nfc, parse_audio, stale_format

log = logging.getLogger("flow.scanner")

MTIME_EPS = 1e-6
DURATION_EPS = 0.05
# Lock hygiene: the scanner commits PER FILE (and the analysis pass per
# track) so its WAL write-lock windows stay milliseconds wide — a busy scan
# must never starve the queue mirror's 3 s playhead writes into 500s.

# Per-file error log persisted with the scan result: enough rows to see the
# shape of a bad rip batch, few enough to stay a settings row.
ERROR_LOG_LIMIT = 500

# Bumped whenever format detection changes what a file indexes as. A scan
# that finds an older value in settings re-sniffs every row once and
# reprocesses those whose stored format the bytes contradict — the upgrade
# path for rows indexed by older releases, without re-reading a healthy
# library. v2: container sniffing past ID3 tags; format from the bytes.
DETECT_VERSION = 2
DETECT_VERSION_KEY = "scan_detect_version"
# Wall-clock start of the last completed walk: a folder image changed after
# it means that folder's tracks need their artwork re-resolved.
WALK_AT_KEY = "scan_walk_at"
# Set by heal.run_startup_heal; the watcher turns it into one boot scan.
HEAL_RESCAN_KEY = "heal_rescan"

# A compilation (TCMP / cpil / COMPILATION) without an album artist groups
# under this name instead of splitting into one album per track artist.
VARIOUS_ARTISTS = "Various Artists"

_FOLDER_ART = frozenset(FOLDER_ARTWORK_NAMES)
_NORM_RE = re.compile(r"[\W_]+")


class Edited(IntFlag):
    """Bitmask of user-overridden fields: the scanner only ever preserves
    these bits; the editors set them."""

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


@dataclass
class _Walk:
    files: list[WalkedFile] = field(default_factory=list)
    # Paths (rel; "" = the root) the walk could not read: removals under
    # them are skipped — an unreadable folder is not a deleted folder.
    failed: set[str] = field(default_factory=set)
    # Folder rel → newest change time of its cover/folder image.
    art_changed: dict[str, float] = field(default_factory=dict)
    # Symlinks that resolve outside the library (never indexed).
    escaped: list[str] = field(default_factory=list)


_TRACK_COLUMNS = (
    "t.id, t.path, t.title, t.artist_id, t.album_id, t.album_artist_id, "
    "t.track_no, t.mtime, t.size, t.duration, t.format, t.media_path, "
    "t.user_edited"
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _settings_upsert(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _setting(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _norm(value: str | None) -> str:
    """Loose text identity for move matching: case, accents' encoding,
    punctuation and spacing don't count."""
    return _NORM_RE.sub(" ", nfc(value or "").casefold()).strip()


def _under(rel: str, roots: set[str]) -> bool:
    return any(root == "" or rel == root or rel.startswith(root + "/") for root in roots)


class _ScanArtwork(ArtworkStore):
    """The scan's artwork resolver: the embedded cover comes from the tag
    pass already done (ParsedTags.picture), so the audio file is never
    opened a second time; folder images keep the per-folder cache."""

    def for_track(self, path: Path, picture: tuple[bytes, str] | None) -> int | None:
        if picture is not None:
            data, mime = picture
            return self._store(data, mime)
        folder = path.parent
        if folder not in self._folder_cache:
            self._folder_cache[folder] = self._folder_artwork_id(folder)
        return self._folder_cache[folder]


class LibraryScanner:
    def __init__(self, db: Database, music_dir: Path, bus: ScanBus) -> None:
        self._db = db
        self._music = music_dir
        self._bus = bus
        self._lock = threading.Lock()
        self._running = False
        # A scan requested while one runs is queued, not dropped: the
        # running walk happened at its start, so it can't have seen the
        # change. (trigger, full) of the follow-up; requests coalesce.
        self._pending: tuple[str, bool] | None = None
        # Set by a queued request: the loudness pass yields at the next
        # track, the follow-up reconcile runs, then analysis resumes.
        self._interrupt = threading.Event()
        # finished_at lives here (not just in settings) so every SSE event
        # carries it — the UI's "Last scan" reads the stream, and an idle
        # event without it would wipe the timestamp back to "never".
        self._state = {
            "state": "idle",
            "phase": None,
            "current": 0,
            "total": 0,
            "errors": 0,
            "finished_at": None,
        }
        # Per-file failures of the last scan (path + reason), persisted at
        # finish and served by GET /api/scan/errors.
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
        """The persisted error log of the last scan."""
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

    def start_scan(self, trigger: str, full: bool = False) -> bool:
        """Kick off a background scan. `full` re-reads every file instead of
        trusting mtime + size (taggers that preserve timestamps). While a
        scan runs, the request is queued — one follow-up reconcile, full if
        any queued request asked for it — and a loudness pass in progress
        is interrupted so the follow-up isn't stuck behind it. Returns True:
        the request is always honored, now or right after the current one."""
        with self._lock:
            if self._running:
                if self._pending is None:
                    self._pending = (trigger, full)
                else:
                    self._pending = (self._pending[0], self._pending[1] or full)
                self._interrupt.set()
                log.debug("Scan requested (trigger=%s) while one runs — queued", trigger)
                return True
            self._running = True
        thread = threading.Thread(
            target=self._scan_thread, args=(trigger, full), name="flow-scan", daemon=True
        )
        thread.start()
        return True

    def run_scan(self, trigger: str, full: bool = False) -> None:
        """Synchronous scan — used directly by tests, wrapped by start_scan."""
        self._reconcile(trigger, full=full)

    def take_heal_request(self) -> bool:
        """True once if the startup heal asked for a boot scan (and clears
        the request)."""
        conn = self._db.connect()
        if _setting(conn, HEAL_RESCAN_KEY) != "1":
            return False
        conn.execute("DELETE FROM settings WHERE key = ?", (HEAL_RESCAN_KEY,))
        conn.commit()
        return True

    # ---- internals -------------------------------------------------------

    def _scan_thread(self, trigger: str, full: bool) -> None:
        handed_off = False
        try:
            while True:
                try:
                    # One idle per run: the reconcile stays "scanning" so
                    # the UI doesn't flash "Last scan" between it and the
                    # loudness pass (the UI refreshes its lists when the
                    # analyze phase starts).
                    self._reconcile(trigger, full=full, settle=False)
                    # Sound Check pass — after the index is correct, and only
                    # when no follow-up is waiting (the follow-up comes
                    # first; analysis resumes after it). Skips itself when
                    # ffmpeg is absent; yields to a queued scan mid-pass.
                    if (
                        not self._interrupt.is_set()
                        and self._analyze_gains()
                        and self._state["state"] == "scanning"
                    ):
                        # Nothing to analyze: the pass published no idle.
                        self._set_state(state="idle", phase=None)
                except Exception:  # noqa: BLE001 - a scan must never take the app down
                    log.exception("Scan crashed")
                    self._recover_after_crash()
                # Exit and the next start_scan's running check share the
                # lock: a request lands either in _pending (run below) or
                # after _running is False (starts its own thread).
                with self._lock:
                    if self._pending is None:
                        self._running = False
                        self._interrupt.clear()
                        handed_off = True
                        return
                    trigger, full = self._pending
                    self._pending = None
                    self._interrupt.clear()
                log.info("Running queued follow-up scan (trigger=%s)", trigger)
        finally:
            self._db.close_thread()
            if not handed_off:
                with self._lock:
                    self._running = False
                    self._pending = None

    def _recover_after_crash(self) -> None:
        try:
            conn = self._db.connect()
            if conn.in_transaction:
                conn.rollback()
            # Persist first so the idle event below carries finished_at.
            self._persist_finish(conn, errors=self._state["errors"])
            conn.commit()
            self._set_state(state="idle", phase=None)
        except Exception:  # noqa: BLE001
            log.exception("Could not reset scan state after crash")

    def _set_state(self, **kwargs) -> None:
        with self._lock:
            self._state.update(kwargs)
            state = dict(self._state)
        self._bus.publish({"type": "state", **state})

    # -- reconcile ---------------------------------------------------------

    def _reconcile(self, trigger: str, full: bool = False, settle: bool = True) -> None:
        """`settle=False` leaves the published state "scanning" at the end —
        the scan thread settles it once its loudness pass is done."""
        log.info(
            "Scan started (trigger=%s, full=%s, root=%s)", trigger, full, self._music
        )
        conn = self._db.connect()
        # Unicode lookup keys for rows that predate them (or were written by
        # an older release after a rollback) — cheap once done.
        if backfill_name_keys(conn):
            conn.commit()
        artstore = _ScanArtwork(conn)

        walk_at = time.time()
        walk = self._walk()
        files = walk.files
        db_rows = {
            row["path"]: row
            for row in conn.execute(
                f"SELECT {_TRACK_COLUMNS}, ar.name AS artist_name, "
                "al.title AS album_title FROM tracks t "
                "LEFT JOIN artists ar ON ar.id = t.artist_id "
                "LEFT JOIN albums al ON al.id = t.album_id"
            )
        }

        # Safety guard: a non-empty index against an empty walk is almost
        # always a broken or missing bind mount, not a user action. Removals
        # are irreversible, so refuse to mass-delete and surface it;
        # resetting a library deliberately = remove the data volume.
        # An unreadable root (wrong owner, chmod 700) gets the same guard,
        # even over an empty index: the scan says why nothing was indexed.
        root_unreadable = "" in walk.failed
        if (not files and db_rows) or root_unreadable:
            log.warning(
                "Library walk found 0 files but the index holds %d tracks — "
                "skipping removals (%s)",
                len(db_rows),
                "library folder unreadable" if root_unreadable else "suspected broken mount",
            )
            reason = (
                f"Library folder {'couldn’t be read (check its permissions)' if root_unreadable else 'was unreachable'}"
                f" — scan skipped removals; {len(db_rows)} tracks kept untouched"
            )
            self._error_log = [{"path": "(library root)", "reason": reason}]
            self._set_state(**_settled(settle), errors=1)
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
        errors = 0
        for rel in walk.escaped:
            self._error_log.append(
                {"path": rel, "reason": "Symlink points outside the library folder — not indexed"}
            )
            errors += 1

        disk = {f.rel: f for f in files}

        disappeared = set(db_rows) - set(disk)
        added = set(disk) - set(db_rows)
        common = set(disk) & set(db_rows)

        # An unreadable folder (permissions, an I/O blip on a network share)
        # hides its files from the walk; they are not gone. Their rows —
        # and the favorites, playlist entries and edits hanging off them —
        # stay untouched until a walk can actually see the folder.
        protected = {rel for rel in disappeared if _under(rel, walk.failed)}
        if protected:
            disappeared -= protected
            for failed in sorted(walk.failed):
                kept = sum(1 for rel in protected if _under(rel, {failed}))
                if not kept:
                    continue
                self._error_log.append(
                    {
                        "path": failed or "(library root)",
                        "reason": f"Couldn't be read — removals skipped; {kept} "
                        f"track{'s' if kept != 1 else ''} kept untouched",
                    }
                )
                errors += 1
            log.warning(
                "%d unreadable path(s) in the library — %d tracks kept",
                len(walk.failed), len(protected),
            )

        if full:
            changed = set(common)
        else:
            changed = {
                rel
                for rel in common
                if abs(db_rows[rel]["mtime"] - disk[rel].mtime) > MTIME_EPS
                or (db_rows[rel]["size"] is not None and db_rows[rel]["size"] != disk[rel].size)
            }

        # A cover/folder image replaced since the last walk: re-resolve the
        # artwork of every track in that folder.
        last_walk = _float_or_none(_setting(conn, WALK_AT_KEY))
        if last_walk is not None:
            stale_art = {d for d, t in walk.art_changed.items() if t > last_walk}
            if stale_art:
                changed |= {rel for rel in common if posixpath.dirname(rel) in stale_art}

        # Rows indexed under older detection rules whose bytes say they are
        # something else (an MP4 stream-rip indexed as mp3, AIFF in a .mp3):
        # re-sniffed once per detection upgrade, reprocessed when wrong.
        detect_upgrade = _int_or_zero(_setting(conn, DETECT_VERSION_KEY)) < DETECT_VERSION
        if detect_upgrade and not full:
            misdetected = {
                rel
                for rel in common - changed
                if not db_rows[rel]["media_path"]
                and stale_format(disk[rel].abs, db_rows[rel]["format"])
            }
            if misdetected:
                log.info("Re-checking %d row(s) indexed under older detection rules", len(misdetected))
            changed |= misdetected

        # Tags parsed during move matching are reused by the upserts below.
        parsed_cache: dict[str, ParsedTags | None] = {}
        moves = self._match_moves(added, disappeared, disk, db_rows, parsed_cache)
        retags = self._match_retagged_moves(
            added - set(moves),
            disappeared - {row["path"] for row in moves.values()},
            disk, db_rows, parsed_cache,
        )
        moved_old_paths = {row["path"] for row in (*moves.values(), *retags.values())}

        # A repaired copy deleted out-of-band (data dir cleaned by hand)
        # leaves a track whose stream 404s though its original never
        # changed — reprocess the original so the repair is re-derived.
        lost_copies = {
            rel
            for rel in common
            if db_rows[rel]["media_path"]
            and not Path(db_rows[rel]["media_path"]).is_file()
        }
        changed |= lost_copies

        removals = disappeared - moved_old_paths
        new_files = added - set(moves) - set(retags)
        total = len(moves) + len(retags) + len(new_files) + len(changed) + len(removals)
        self._set_state(state="scanning", phase="scan", current=0, total=total, errors=errors)
        self._persist_start(conn, total=total)
        conn.commit()

        processed = 0
        touched_albums: set[int] = set()
        unindexed: list[WalkedFile] = []

        def tick() -> None:
            nonlocal processed
            processed += 1
            self._set_state(state="scanning", current=processed)

        def upsert(f: WalkedFile, existing_id: int | None) -> None:
            nonlocal errors
            ok, note = self._safe_upsert(
                conn, artstore, f, existing_id, parsed_cache.pop(f.rel, None),
                full=full, touched_albums=touched_albums,
            )
            if not ok:
                errors += 1
                unindexed.append(f)
            elif note:
                errors += 1  # surfaced in the error log; the track is indexed
            tick()
            self._persist_progress(conn, processed, errors)
            conn.commit()

        for rel in sorted(moves):
            conn.execute(
                "UPDATE tracks SET path = ? WHERE id = ?", (rel, moves[rel]["id"])
            )
            tick()
            # Lock hygiene: one tiny transaction per row — the queue mirror's
            # writes land in the gaps instead of piling into 500s.
            conn.commit()

        # Moved AND rewritten (retag-and-move): keep the row, then reread it.
        for rel in sorted(retags):
            conn.execute(
                "UPDATE tracks SET path = ? WHERE id = ?", (rel, retags[rel]["id"])
            )
            conn.commit()
            upsert(disk[rel], retags[rel]["id"])

        # Files matched as moves are already handled above — skip them here.
        for rel in sorted(new_files):
            upsert(disk[rel], None)

        for rel in sorted(changed):
            upsert(disk[rel], db_rows[rel]["id"])

        for rel in sorted(removals):
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

        self._refresh_album_artwork(conn, touched_albums)
        prune_orphans(conn)
        _settings_upsert(conn, WALK_AT_KEY, repr(walk_at))
        if detect_upgrade:
            _settings_upsert(conn, DETECT_VERSION_KEY, str(DETECT_VERSION))
        self._persist_finish(conn, errors=errors)
        conn.commit()
        artstore.reset()
        self._sweep_repairs(conn, unindexed)
        self._set_state(**_settled(settle), current=total, total=total, errors=errors)
        log.info(
            "Scan finished (trigger=%s): %d new/changed, %d moves, %d removed, %d errors",
            trigger, len(new_files) + len(changed), len(moves) + len(retags),
            len(removals), errors,
        )

    def _sweep_repairs(self, conn, unindexed: list[WalkedFile]) -> None:
        referenced = {
            Path(row["media_path"]).name
            for row in conn.execute(
                "SELECT media_path FROM tracks WHERE media_path IS NOT NULL"
            )
        }
        live_failures = {repair_key(f.rel, f.size, f.mtime) for f in unindexed}
        try:
            sweep(referenced, live_failures)
        except Exception:  # noqa: BLE001 - housekeeping never fails a scan
            log.warning("Repair sweep failed", exc_info=True)

    def _refresh_album_artwork(self, conn, album_ids: set[int]) -> None:
        """An album whose cover no longer belongs to any of its tracks (the
        folder image was replaced, the tracks were retagged) takes the first
        track's artwork again. Albums still showing one of their tracks'
        covers keep it — the first-seen choice stands."""
        for album_id in sorted(album_ids):
            conn.execute(
                "UPDATE albums SET artwork_id = ("
                "  SELECT t.artwork_id FROM tracks t"
                "  WHERE t.album_id = albums.id AND t.artwork_id IS NOT NULL"
                "  ORDER BY t.disc_no IS NULL, t.disc_no, t.track_no IS NULL,"
                "           t.track_no, t.id LIMIT 1"
                ") WHERE id = ? AND (artwork_id IS NULL OR artwork_id NOT IN ("
                "  SELECT artwork_id FROM tracks"
                "  WHERE album_id = ? AND artwork_id IS NOT NULL))",
                (album_id, album_id),
            )
        conn.commit()

    # -- classification ----------------------------------------------------

    def _parsed(self, f: WalkedFile, cache: dict[str, ParsedTags | None]) -> ParsedTags | None:
        if f.rel not in cache:
            cache[f.rel] = parse_audio(f.abs)
        return cache[f.rel]

    def _match_moves(
        self,
        added: set[str],
        disappeared: set[str],
        disk: dict[str, WalkedFile],
        db_rows: dict,
        cache: dict[str, ParsedTags | None],
    ) -> dict[str, dict]:
        """New path + vanished row with identical size and mtime → move."""
        moves: dict[str, dict] = {}
        by_signature: dict[tuple[int, float], list[str]] = defaultdict(list)
        for old in disappeared:
            row = db_rows[old]
            by_signature[(row["size"], round(row["mtime"], 6))].append(old)
        vanished = set(disappeared)
        for rel in sorted(added):
            f = disk[rel]
            candidates = [
                old
                for old in by_signature.get((f.size, round(f.mtime, 6)), ())
                if old in vanished
            ]
            if not candidates:
                continue
            if len(candidates) > 1:
                parsed = self._parsed(f, cache)
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

    def _match_retagged_moves(
        self,
        added: set[str],
        vanished: set[str],
        disk: dict[str, WalkedFile],
        db_rows: dict,
        cache: dict[str, ParsedTags | None],
    ) -> dict[str, dict]:
        """Second pass for moves that also changed the bytes (a tagger's
        retag-and-move, `cp` without -p): same duration (±0.05 s), same
        format, same normalized title/album/artist. Fields the user edited
        aren't compared (the row holds their overlay, not the tag). A match
        only counts when it is unique both ways — a wrong match would hand
        one song's favorites and plays to another."""
        if not added or not vanished:
            return {}
        by_format: dict[str, list[str]] = defaultdict(list)
        for old in vanished:
            row = db_rows[old]
            if not row["media_path"]:
                by_format[row["format"]].append(old)
        if not by_format:
            return {}
        claims: dict[str, list[str]] = defaultdict(list)
        for rel in sorted(added):
            parsed = self._parsed(disk[rel], cache)
            if parsed is None or parsed.format not in by_format:
                continue
            title = parsed.title or derive_from_filename(rel)[1]
            mine = {
                Edited.TITLE: _norm(title),
                Edited.ALBUM: _norm(parsed.album),
                Edited.ARTIST: _norm(parsed.artist),
            }
            candidates = []
            for old in by_format[parsed.format]:
                row = db_rows[old]
                if abs((row["duration"] or 0.0) - parsed.duration) > DURATION_EPS:
                    continue
                edited = Edited(row["user_edited"])
                theirs = {
                    Edited.TITLE: _norm(row["title"]),
                    Edited.ALBUM: _norm(row["album_title"]),
                    Edited.ARTIST: _norm(row["artist_name"]),
                }
                compared = [bit for bit in mine if bit not in edited]
                if compared and all(mine[bit] == theirs[bit] for bit in compared):
                    candidates.append(old)
            if len(candidates) == 1:
                claims[candidates[0]].append(rel)
        return {
            rels[0]: db_rows[old] for old, rels in claims.items() if len(rels) == 1
        }

    # -- upserts -----------------------------------------------------------

    def _safe_upsert(
        self, conn, artstore, f: WalkedFile, existing_id: int | None,
        parsed: ParsedTags | None, *, full: bool, touched_albums: set[int],
    ) -> tuple[bool, str | None]:
        """_upsert_file with a per-file safety net: one unexpected failure
        is logged against its file and the scan moves on."""
        try:
            return self._upsert_file(
                conn, artstore, f, existing_id, parsed,
                full=full, touched_albums=touched_albums,
            )
        except Exception as exc:  # noqa: BLE001 - one file must not abort the scan
            log.exception("Unexpected error indexing %s", f.rel)
            if conn.in_transaction:
                conn.rollback()
            self._error_log.append(
                {"path": f.rel, "reason": f"Unexpected error ({type(exc).__name__}: {exc})"}
            )
            return False, None

    def _upsert_file(
        self, conn, artstore, f: WalkedFile, existing_id: int | None,
        parsed: ParsedTags | None = None, *, full: bool = False,
        touched_albums: set[int] | None = None,
    ) -> tuple[bool, str | None]:
        """Parse and write one file. Returns (indexed, note). A file mutagen
        refuses — or one browsers can't play as-is (AIFF, raw ADTS, bytes
        that contradict their name) — gets one repair attempt: a lossless
        remux verified before it may enter the index. The original is never
        modified — the row points at the copy via media_path, and the copy
        is re-derived whenever the original changes or the copy itself
        disappears."""
        if parsed is None:
            parsed = parse_audio(f.abs)
        media_path: str | None = None
        detail: str | None = None
        note: str | None = None
        if parsed is None or not parsed.playable:
            result = repair_file(f.rel, f.abs, mtime=f.mtime, size=f.size, retry=full)
            detail = result.detail
            if result.path is not None and result.parsed is not None:
                parsed = result.parsed
                media_path = str(result.path)
                if result.note:
                    note = f"Partially recovered — {result.note}; indexed anyway"
        if parsed is None:
            # One user-facing line per file already went out from tags.py;
            # the persisted scan error log is the durable record.
            log.debug("Skipping unparseable file: %s", f.rel)
            reason = "Unreadable or unrecognized audio file"
            if detail:
                reason += f" — repair attempted but failed ({detail})"
            self._error_log.append({"path": f.rel, "reason": reason})
            return False, None
        if not parsed.playable and media_path is None and detail:
            note = (
                f"Indexed as {parsed.format or 'unknown format'}, which most "
                f"browsers can't play — repair failed ({detail})"
            )

        # The streamed format follows the bytes that actually play — the
        # sniffed container (a remuxed copy's is canonical: m4a for AAC,
        # wav for PCM, …), never the file name.
        fmt = parsed.format or f.abs.suffix.lower().lstrip(".")
        fallback_track_no, fallback_title = derive_from_filename(f.rel)

        # Overlay decisions read the row INSIDE the write transaction: an
        # edit saved while this scan was running must win, not be
        # overwritten by the scan-start snapshot and then pinned.
        if not conn.in_transaction:
            conn.execute("BEGIN IMMEDIATE")
        existing = None
        if existing_id is not None:
            existing = conn.execute(
                "SELECT id, title, artist_id, album_id, album_artist_id, track_no, "
                "media_path, user_edited FROM tracks WHERE id = ?",
                (existing_id,),
            ).fetchone()
        edited = Edited(existing["user_edited"]) if existing else Edited(0)

        # Overlay semantics: user-edited columns keep their current value —
        # that value IS the overlay. Everything else follows the tags.
        if Edited.TITLE in edited:
            title = existing["title"]
        else:
            title = parsed.title or fallback_title

        if Edited.TRACK_NO in edited:
            track_no = existing["track_no"]
        else:
            track_no = parsed.track_no if parsed.track_no is not None else fallback_track_no

        if Edited.ARTIST in edited:
            artist_id = existing["artist_id"]
        else:
            artist_id = find_or_create_artist(conn, parsed.artist)

        if Edited.ALBUM_ARTIST in edited:
            # The user pinned this album's compilation semantics; their
            # choice outranks the tag on every rescan.
            album_artist_id = existing["album_artist_id"]
        else:
            album_artist = parsed.album_artist or (
                VARIOUS_ARTISTS if parsed.compilation else parsed.artist
            )
            album_artist_id = find_or_create_artist(conn, album_artist)
        if Edited.ALBUM in edited:
            album_id = existing["album_id"]
        else:
            album_id = find_or_create_album(
                conn, parsed.album, album_artist_id, parsed.year
            )

        # Embedded art comes from the tag pass (a repaired track's from its
        # remuxed copy, which carries the mapped cover); the folder fallback
        # still reads the library folder.
        artwork_id = artstore.for_track(f.abs, parsed.picture)

        # Album-level facts follow the first track seen: artwork backfills
        # only when the album has none yet (stale covers are refreshed at
        # the end of the scan).
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
            "format": fmt,
            "bitrate": parsed.bitrate,
            "sample_rate": parsed.sample_rate,
            # A tag-provided ReplayGain is the free, exact loudness value
            # (re-referenced from −18 LUFS to the Sound Check target);
            # otherwise it stays NULL for the analysis phase.
            "gain_db": (
                gain_from_replaygain(parsed.replaygain_db)
                if parsed.replaygain_db is not None
                else None
            ),
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
            if touched_albums is not None and existing["album_id"] is not None:
                touched_albums.add(existing["album_id"])
            sets = ", ".join(f"{col} = ?" for col in values)
            conn.execute(
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
        if touched_albums is not None and album_id is not None:
            touched_albums.add(album_id)

        # Credited artists always follow the tags; the primary display
        # credit follows the (overlay-aware) artist column. Genres follow
        # the tags too — unless the user set one: their choice is the
        # overlay, so the tag genre never overwrites it.
        set_track_credits(
            conn,
            track_id,
            primary_artist_id=artist_id,
            main=parsed.artists,
            featured=parsed.featured,
            composers=parsed.composers,
        )
        if Edited.GENRE not in edited:
            set_track_genres(conn, track_id, parsed.genres)
        if note:
            self._error_log.append({"path": f.rel, "reason": note})
        return True, note

    # -- walk --------------------------------------------------------------

    def _walk(self) -> _Walk:
        """Every library file with its stat, plus what the walk could NOT
        see: folders and files that failed to list or stat (so removals
        under them are skipped), symlinks that escape the library root (never
        indexed or streamed), and folder-image change times."""
        out = _Walk()
        root = self._music
        try:
            root_real = os.path.realpath(root)
        except OSError:
            root_real = str(root)
        stack: list[Path] = [root]
        while stack:
            folder = stack.pop()
            folder_rel = "" if folder == root else folder.relative_to(root).as_posix()
            try:
                with os.scandir(folder) as it:
                    entries = sorted(it, key=lambda e: e.name)
            except OSError as exc:
                if exc.errno not in (errno.ENOENT, errno.ENOTDIR) or folder == root:
                    out.failed.add(folder_rel)
                continue
            subdirs: list[Path] = []
            for entry in entries:
                name = entry.name
                if name.startswith("."):  # hidden + AppleDouble (._*) noise
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    is_dir = False
                if is_dir:
                    subdirs.append(Path(entry.path))
                    continue
                lower = name.lower()
                if lower in _FOLDER_ART:
                    try:
                        st = entry.stat()
                    except OSError:
                        continue
                    changed_at = max(st.st_mtime, st.st_ctime)
                    if changed_at > out.art_changed.get(folder_rel, 0.0):
                        out.art_changed[folder_rel] = changed_at
                    continue
                if os.path.splitext(lower)[1] not in config.LIBRARY_EXTENSIONS:
                    continue
                rel = f"{folder_rel}/{name}" if folder_rel else name
                if entry.is_symlink():
                    # A link may point anywhere the container can read
                    # (flow.db renamed x.mp3, say): only targets inside
                    # the library are indexed — and so streamable.
                    try:
                        target = os.path.realpath(entry.path)
                    except OSError:
                        continue
                    if target != root_real and not target.startswith(root_real + os.sep):
                        out.escaped.append(rel)
                        continue
                try:
                    st = entry.stat()
                except OSError as exc:
                    if exc.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                        out.failed.add(rel)
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                out.files.append(
                    WalkedFile(rel=rel, abs=Path(entry.path), mtime=st.st_mtime, size=st.st_size)
                )
            # Depth-first, in name order (reversed onto the stack).
            stack.extend(reversed(subdirs))
        return out

    # -- loudness analysis -------------------------------------------------

    def _analyze_gains(self) -> bool:
        """Sound Check pass: fill `gain_db` for every track still missing a
        value (new files without ReplayGain tags, and anything scanned
        before ffmpeg was available). Runs under phase="analyze" on the
        scan's own SSE stream; ffmpeg absent → the pass is a no-op and the
        app simply plays at unity gain. A queued scan request interrupts it
        between tracks — the follow-up reconcile runs, and the next pass
        picks up where this one stopped (rows still NULL). Returns False
        when interrupted."""
        if not ffmpeg_available():
            return True
        conn = self._db.connect()
        rows = conn.execute(
            "SELECT id, path, media_path FROM tracks WHERE gain_db IS NULL ORDER BY id"
        ).fetchall()
        if not rows:
            return True
        total = len(rows)
        log.info("Loudness analysis started (%d tracks)", total)
        self._set_state(state="scanning", phase="analyze", current=0, total=total)
        _settings_upsert(conn, "scan_total", str(total))
        _settings_upsert(conn, "scan_current", "0")
        conn.commit()
        processed = 0
        analyzed = 0
        for row in rows:
            if self._interrupt.is_set():
                log.info(
                    "Loudness analysis paused at %d/%d for a queued scan", processed, total
                )
                return False
            # Repaired tracks analyze their remuxed copy — the original's
            # bytes are what mutagen refused in the first place.
            source = (
                Path(row["media_path"])
                if row["media_path"]
                else self._music / row["path"]
            )
            gain = analyze_file(source)
            # The write transaction opens at the UPDATE below and ends at
            # the commit — ffmpeg NEVER runs inside one. A transaction held
            # across ~25 analyses (the old batching) kept the WAL write lock
            # for minutes and 500'd the queue mirror. `gain_db IS NULL`: a
            # rescan may have filled it from a new tag meanwhile.
            if gain is not None:
                conn.execute(
                    "UPDATE tracks SET gain_db = ? WHERE id = ? AND gain_db IS NULL",
                    (gain, row["id"]),
                )
                analyzed += 1
            processed += 1
            self._set_state(state="scanning", phase="analyze", current=processed)
            if processed % 25 == 0:
                _settings_upsert(conn, "scan_current", str(processed))
            conn.commit()
        log.info("Loudness analysis finished (%d/%d measured)", analyzed, total)
        # The scan is only done when the UI says so.
        errors = self._state["errors"]
        self._persist_finish(conn, errors=errors)
        conn.commit()
        self._set_state(state="idle", phase=None, current=total, total=total, errors=errors)
        return True

    # -- settings persistence (reload shows scan state) ---------------------

    def _persist_start(self, conn, total: int) -> None:
        self._state["finished_at"] = None
        _settings_upsert(conn, "scan_state", "scanning")
        _settings_upsert(conn, "scan_total", str(total))
        _settings_upsert(conn, "scan_current", "0")
        _settings_upsert(conn, "scan_errors", "0")
        _settings_upsert(conn, "scan_finished_at", "")

    def _persist_progress(self, conn, current: int, errors: int) -> None:
        _settings_upsert(conn, "scan_current", str(current))
        _settings_upsert(conn, "scan_errors", str(errors))

    def _persist_finish(self, conn, errors: int) -> None:
        finished_at = _utcnow()
        self._state["finished_at"] = finished_at
        _settings_upsert(conn, "scan_state", "idle")
        _settings_upsert(conn, "scan_finished_at", finished_at)
        _settings_upsert(conn, "scan_errors", str(errors))
        # Path + reason for every skipped file, capped so a catastrophically
        # bad mount can't grow a settings row without bound. `total` keeps
        # the honest count either way.
        logged = len(self._error_log)
        payload = {
            "total": logged,
            "truncated": logged > ERROR_LOG_LIMIT,
            "items": self._error_log[:ERROR_LOG_LIMIT],
        }
        _settings_upsert(conn, "scan_error_log", json.dumps(payload))


def _settled(settle: bool) -> dict:
    """The closing state fields of a reconcile: idle, or unchanged."""
    return {"state": "idle", "phase": None} if settle else {}


def _float_or_none(value: str | None) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
        return None


def _int_or_zero(value: str | None) -> int:
    try:
        return int(value) if value else 0
    except ValueError:
        return 0
