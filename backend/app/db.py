"""SQLite access: connection factory, pragmas, and user_version migrations.

No ORM (DESIGN.md §3). Connections are thread-local: FastAPI request handlers
and the scanner thread each get their own connection, WAL keeps them honest.
"""

from __future__ import annotations

import sqlite3
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
