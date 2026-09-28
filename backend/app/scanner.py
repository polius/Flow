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
from app.events import ScanBus
from app.tags import derive_from_filename, parse_audio

log = logging.getLogger("flow.scanner")

MTIME_EPS = 1e-6
DURATION_EPS = 0.05
COMMIT_EVERY = 200


class Edited(IntFlag):
    """Bitmask of user-overridden fields (DESIGN.md §5). The scanner only
    ever preserves these bits; the Get Info editor (M4) sets them."""

    TITLE = 1
    ARTIST = 2
    ALBUM = 4
    TRACK_NO = 8


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
            "SELECT value FROM settings WHERE key = 'scan_finished_at'"
        ).fetchone()
        return {"type": "state", **state, "finished_at": row["value"] if row else None}

    def start_scan(self, trigger: str) -> bool:
        """Kick off a background scan. False if one is already running."""
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
                "SELECT id, path, title, artist_id, album_id, track_no, "
                "mtime, size, duration, user_edited FROM tracks"
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
            self._set_state(state="idle", phase=None, errors=1)
            self._persist_finish(conn, errors=1)
            conn.commit()
            return

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

        # Files matched as moves are already handled above — skip them here.
        for rel in sorted(added - set(moves)):
            if not self._upsert_file(conn, artstore, disk[rel], None):
                errors += 1
            tick()
            if processed % COMMIT_EVERY == 0:
                self._persist_progress(conn, processed, errors)
                conn.commit()

        for rel in sorted(changed):
            if not self._upsert_file(conn, artstore, disk[rel], db_rows[rel]):
                errors += 1
            tick()
            if processed % COMMIT_EVERY == 0:
                self._persist_progress(conn, processed, errors)
                conn.commit()

        for rel in sorted(disappeared - moved_old_paths):
            conn.execute("DELETE FROM tracks WHERE id = ?", (db_rows[rel]["id"],))
            tick()

        _prune_orphans(conn)
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
        """Parse and write one file. Returns False on parse failure."""
        parsed = parse_audio(f.abs)
        if parsed is None:
            log.warning("Skipping unparseable file: %s", f.rel)
            return False

        suffix = f.abs.suffix.lower().lstrip(".")
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
            artist_id = self._find_or_create_artist(conn, parsed.artist)

        album_artist_id = self._find_or_create_artist(
            conn, parsed.album_artist or parsed.artist
        )
        if Edited.ALBUM in edited and existing:
            album_id = existing["album_id"]
        else:
            album_id = self._find_or_create_album(
                conn, parsed.album, album_artist_id, parsed.year
            )

        artwork_id = artstore.resolve(f.abs, f.abs.suffix.lower())

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
            "mtime": f.mtime,
            "size": f.size,
            "artwork_id": artwork_id,
        }

        if existing:
            sets = ", ".join(f"{col} = ?" for col in values)
            conn.execute(
                f"UPDATE tracks SET {sets} WHERE id = ?",
                (*values.values(), existing["id"]),
            )
        else:
            columns = ", ".join(values)
            placeholders = ", ".join("?" for _ in values)
            conn.execute(
                f"INSERT INTO tracks ({columns}, user_edited, added_at) "
                f"VALUES ({placeholders}, 0, ?)",
                (*values.values(), _utcnow()),
            )
        return True

    def _find_or_create_artist(self, conn, name: str | None) -> int | None:
        if not name or not name.strip():
            return None
        name = name.strip()
        row = conn.execute(
            "SELECT id FROM artists WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        if row:
            return row["id"]
        cur = conn.execute("INSERT INTO artists (name) VALUES (?)", (name,))
        return int(cur.lastrowid)

    def _find_or_create_album(
        self, conn, title: str | None, artist_id: int | None, year: int | None
    ) -> int | None:
        if not title or not title.strip():
            return None
        title = title.strip()
        row = conn.execute(
            "SELECT id, year, artwork_id FROM albums "
            "WHERE title = ? COLLATE NOCASE AND artist_id IS ?",
            (title, artist_id),
        ).fetchone()
        if row:
            # Backfill album-level facts from tracks that carry them.
            if row["year"] is None and year is not None:
                conn.execute("UPDATE albums SET year = ? WHERE id = ?", (year, row["id"]))
            return row["id"]
        cur = conn.execute(
            "INSERT INTO albums (title, artist_id, year) VALUES (?, ?, ?)",
            (title, artist_id, year),
        )
        return int(cur.lastrowid)

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


def _prune_orphans(conn) -> None:
    """Derived entities (§13.2): rows with no referencing track are removed."""
    conn.execute(
        "DELETE FROM albums WHERE id NOT IN "
        "(SELECT album_id FROM tracks WHERE album_id IS NOT NULL)"
    )
    conn.execute(
        "DELETE FROM artists WHERE id NOT IN ("
        "  SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL"
        "  UNION SELECT album_artist_id FROM tracks WHERE album_artist_id IS NOT NULL"
        "  UNION SELECT artist_id FROM albums WHERE artist_id IS NOT NULL)"
    )
    conn.execute(
        "DELETE FROM artwork WHERE id NOT IN ("
        "  SELECT artwork_id FROM tracks WHERE artwork_id IS NOT NULL"
        "  UNION SELECT artwork_id FROM albums WHERE artwork_id IS NOT NULL)"
    )
