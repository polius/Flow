"""SQLite access: connection factory, pragmas, and user_version migrations.

No ORM (DESIGN.md §3). Connections are thread-local: FastAPI request handlers
and the scanner thread each get their own connection, WAL keeps them honest.

Write-lock hygiene: WAL still allows one writer at a time, so every writer
keeps its transactions SHORT (the scanner commits per file; the analysis
pass never holds a transaction across an ffmpeg run) and every request-side
writer goes through `retry_locked`, which out-waits a busy scan with
backoff instead of surfacing `database is locked` as a 500.
"""

from __future__ import annotations

import random
import sqlite3
import time
from pathlib import Path
from threading import local

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._local = local()

    def init(self) -> None:
        """Create parent dirs and apply pending migrations. Call once at startup."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            self.migrate(conn)

    def connect(self) -> sqlite3.Connection:
        """Return this thread's connection, creating it on first use."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            # WAL + NORMAL: commits don't fsync (checkpoints do). The scanner
            # commits per file to keep write locks short — per-commit fsyncs
            # would make that pause the whole library for disk latency. This
            # is the standard WAL trade: durability across power loss, never
            # consistency.
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn = conn
        return conn

    def close_thread(self) -> None:
        """Close this thread's connection (scanner threads are ephemeral)."""
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def migrate(self, conn: sqlite3.Connection) -> None:
        """Apply migrations/*.sql in order, tracking progress via user_version."""
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        for script in sorted(MIGRATIONS_DIR.glob("[0-9]*.sql")):
            version = int(script.name.split("_", 1)[0])
            if version <= current:
                continue
            conn.executescript(script.read_text(encoding="utf-8"))
            conn.execute(f"PRAGMA user_version = {version}")
            conn.commit()


def retry_locked(conn: sqlite3.Connection, fn, *, deadline: float = 15.0):
    """Run one unit of work (which ends in `conn.commit()`), retrying while
    SQLite reports the database locked or busy.

    WAL allows one writer at a time; `busy_timeout` (5 s) already makes a
    single statement wait, but a writer that wants to stay honest across a
    busy scan needs to out-wait a whole lock window, not one statement. The
    backoff (0.05 s growing to ~0.5 s, jittered so concurrent writers don't
    retry in lockstep) spans `deadline` seconds in total — far longer than
    any per-file scanner transaction, and the scanner is written to commit
    per file precisely so these windows stay tiny.

    On a locked failure the connection is rolled back (the attempt's partial
    writes are discarded — callers keep their work inside `fn` so a retry
    replays it whole) and the attempt repeats. Anything that is not a lock
    error — a genuine constraint, a closed database — re-raises immediately.
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
