"""SQLite access: thread-local connections, WAL pragmas, user_version migrations (no ORM)."""

from __future__ import annotations

import logging
import random
import sqlite3
import threading
import time
import weakref
from datetime import datetime, timezone
from pathlib import Path
from threading import local

log = logging.getLogger("flow.db")

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

# Pre-migration snapshots (VACUUM INTO) live next to the database; only the
# newest few are kept so a long-lived install doesn't accumulate copies.
BACKUP_DIR_NAME = "backups"
BACKUPS_KEPT = 3

# Every live Database, so a request wrapper can roll back the current
# thread's connection without knowing which instance served it.
_DATABASES: weakref.WeakSet[Database] = weakref.WeakSet()


class SchemaTooNewError(RuntimeError):
    """The database was migrated by a newer Flow than this one."""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._local = local()
        # Every connection ever opened, so tests and shutdown can close the
        # ones owned by pool threads (each would otherwise be closed by the
        # garbage collector with a ResourceWarning).
        self._all: list[sqlite3.Connection] = []
        self._all_lock = threading.Lock()
        _DATABASES.add(self)

    def init(self) -> None:
        """Create parent dirs and apply pending migrations. Call once at startup."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate(self.connect())
        # The startup thread rarely queries again; don't leave its
        # connection open for the life of the process.
        self.close_thread()

    def connect(self) -> sqlite3.Connection:
        """Return this thread's connection, creating it on first use."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            # check_same_thread=False only so close_all() may close a pool
            # thread's connection; each connection is still used by the one
            # thread that opened it.
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            # WAL + NORMAL: commits don't fsync (checkpoints do). The scanner
            # commits per file, so per-commit fsyncs would stall the whole
            # library on disk latency; the standard WAL trade.
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn = conn
            with self._all_lock:
                self._all.append(conn)
        return conn

    def close_thread(self) -> None:
        """Close this thread's connection (scanner threads are ephemeral)."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None
            with self._all_lock:
                self._all = [c for c in self._all if c is not conn]

    def close_all(self) -> None:
        """Close every connection this Database opened, on any thread. Only
        safe when no other thread is mid-query (test teardown)."""
        with self._all_lock:
            conns, self._all = self._all, []
        for conn in conns:
            try:
                conn.close()
            except sqlite3.Error:  # pragma: no cover - already closed
                pass
        self._local = local()

    def rollback_thread(self) -> None:
        """Discard this thread's open transaction, if any. A request that
        raised after a write must not leave the write lock held (every other
        connection would see "database is locked") or let its half-done
        writes ride into the next request's commit on this thread."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None and conn.in_transaction:
            try:
                conn.rollback()
            except sqlite3.Error:  # pragma: no cover - connection unusable
                log.exception("Rollback after a failed request failed")

    # ---- migrations ------------------------------------------------------

    @staticmethod
    def _scripts() -> list[tuple[int, Path]]:
        return sorted(
            (int(p.name.split("_", 1)[0]), p) for p in MIGRATIONS_DIR.glob("[0-9]*.sql")
        )

    def migrate(self, conn: sqlite3.Connection) -> None:
        """Apply migrations/*.sql in order, tracking progress via user_version.

        Each file runs in its own transaction together with its user_version
        bump, so a failure leaves the database exactly at the previous
        version (the next boot retries cleanly instead of crash-looping on
        "table already exists"). Before anything is applied to an existing
        database a VACUUM INTO snapshot is taken. A database stamped by a
        newer Flow is refused rather than run against an unknown schema.
        """
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        scripts = self._scripts()
        known = scripts[-1][0] if scripts else 0
        if current > known:
            raise SchemaTooNewError(
                f"{self.path} is at schema version {current}, but this Flow build "
                f"only knows up to version {known}. It was opened by a newer Flow: "
                f"upgrade Flow again, or restore a backup from "
                f"{self.path.parent / BACKUP_DIR_NAME}."
            )
        pending = [(v, p) for v, p in scripts if v > current]
        if not pending:
            return
        if current > 0:
            self._backup(conn, current)
        for version, script in pending:
            sql = script.read_text(encoding="utf-8")
            try:
                # executescript commits any pending transaction first, then
                # runs the text as-is — so the BEGIN/COMMIT here make the
                # whole file plus its version stamp one atomic unit.
                conn.executescript(
                    f"BEGIN IMMEDIATE;\n{sql}\n;\nPRAGMA user_version = {version};\nCOMMIT;"
                )
            except sqlite3.Error:
                if conn.in_transaction:
                    conn.rollback()
                log.exception("Migration %s failed; database left at version %s",
                              script.name, current)
                raise
            log.info("Applied migration %s", script.name)
            current = version

    def _backup(self, conn: sqlite3.Connection, version: int) -> None:
        """Snapshot the database before migrating it. A failed backup (disk
        full, read-only dir) is logged, not fatal: the migrations themselves
        are atomic, and refusing to boot would crash-loop the container."""
        backup_dir = self.path.parent / BACKUP_DIR_NAME
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = backup_dir / f"{self.path.stem}-v{version}-{stamp}.db"
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target.unlink()
            conn.execute("VACUUM INTO ?", (str(target),))
            log.info("Backed up the database to %s before migrating", target)
        except (OSError, sqlite3.Error):
            log.warning("Could not back up the database before migrating", exc_info=True)
            return
        backups = sorted(backup_dir.glob(f"{self.path.stem}-v*-*.db"))
        for old in backups[:-BACKUPS_KEPT]:
            try:
                old.unlink()
            except OSError:  # pragma: no cover
                pass


def rollback_thread_connections() -> None:
    """Roll back the calling thread's open transaction on every Database."""
    for database in list(_DATABASES):
        database.rollback_thread()


def retry_locked(conn: sqlite3.Connection, fn, *, deadline: float = 15.0):
    """Run one unit of work (which ends in `conn.commit()`), retrying while
    SQLite reports the database locked or busy. The backoff (0.05 s growing
    to ~0.5 s, jittered) spans `deadline` seconds — out-waits a whole scan
    lock window, not one statement. On a locked failure the connection is
    rolled back (callers keep their work inside `fn`, so a retry replays it
    whole); anything that is not a lock error re-raises immediately.
    """
    start = time.monotonic()
    attempt_delay = 0.05
    while True:
        try:
            return fn()
        except sqlite3.OperationalError as exc:
            message = str(exc).lower()
            if "locked" not in message and "busy" not in message:
                raise
            if time.monotonic() - start >= deadline:
                raise
            conn.rollback()  # discard the attempt's partial writes
            time.sleep(attempt_delay * (0.8 + 0.4 * random.random()))
            attempt_delay = min(attempt_delay * 1.5, 0.5)
