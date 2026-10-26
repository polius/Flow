"""Heal libraries indexed under older detection rules: automatically at startup, or by hand with `python -m app.heal`.

Older releases trusted mutagen's verdict and the file extension. Stream-rips
(MP4/DASH, ADTS or Ogg bytes behind an ID3v2 tag, named .mp3) could index as
format=mp3 when mutagen's frame-sync hunt validated a decoy header, and AIFF
or WAV bytes in a .mp3 indexed as mp3 too — all served as audio/mpeg, which
browsers fail on. The scanner now sniffs the real container (tags.py) and
re-checks every row once whenever detection improves (scanner.DETECT_VERSION).

Startup (main.py lifespan → run_startup_heal): cheap and idempotent. It fills
the Unicode lookup keys of artists/albums that lack them, and — when the
library was last scanned under older detection rules and FLOW_AUTO_HEAL is
on — asks for one rescan at boot (the watcher starts it), so mislabeled rows
are repaired without anyone running a command. No file is read at boot.

Manual (kept for existing docs and habits):

    docker exec <container> python -m app.heal

sniffs every non-repaired row now, zeroes the stored mtime of the ones whose
bytes contradict their format, and asks for the same boot-style rescan; the
next scan (Rescan in Settings → Library, or a restart) reprocesses them
through repair. Originals are never modified; only the rows' mtime changes.
"""

from __future__ import annotations

import logging

from app import config
from app.db import Database
from app.entities import backfill_name_keys
from app.scanner import DETECT_VERSION, DETECT_VERSION_KEY, HEAL_RESCAN_KEY
from app.tags import stale_format

log = logging.getLogger("flow.heal")


def run_startup_heal(db: Database) -> None:
    """Once per boot, before the watcher starts. Never raises: a failed
    heal must not keep the server from starting."""
    try:
        conn = db.connect()
        filled = backfill_name_keys(conn)
        if filled:
            log.info("Filled lookup keys for %d artist/album row(s)", filled)
        conn.commit()
        if not config.AUTO_HEAL:
            return
        has_tracks = conn.execute("SELECT 1 FROM tracks LIMIT 1").fetchone() is not None
        version = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (DETECT_VERSION_KEY,)
        ).fetchone()
        current = int(version["value"]) if version and version["value"].isdigit() else 0
        if has_tracks and current < DETECT_VERSION:
            _request_rescan(conn)
            conn.commit()
            log.info(
                "File detection improved since the last scan — a rescan will "
                "re-check the library (FLOW_AUTO_HEAL=off to skip)"
            )
    except Exception:  # noqa: BLE001 - boot must go on
        log.exception("Startup heal failed")


def mark_misdetected(conn) -> list[str]:
    """Zero the stored mtime of every non-repaired row whose bytes
    contradict its format, so the next scan reprocesses it. Returns the
    marked paths; the caller commits."""
    marked: list[str] = []
    rows = conn.execute(
        "SELECT id, path, format FROM tracks WHERE media_path IS NULL"
    ).fetchall()
    for row in rows:
        if stale_format(config.MUSIC_DIR / row["path"], row["format"]):
            conn.execute("UPDATE tracks SET mtime = 0 WHERE id = ?", (row["id"],))
            marked.append(row["path"])
    return marked


def _request_rescan(conn) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, '1') "
        "ON CONFLICT(key) DO UPDATE SET value = '1'",
        (HEAL_RESCAN_KEY,),
    )


def main() -> None:
    db = Database(config.DB_PATH)
    db.init()  # idempotent: standalone run must not depend on app startup
    conn = db.connect()
    backfill_name_keys(conn)
    total = conn.execute(
        "SELECT COUNT(*) AS c FROM tracks WHERE media_path IS NULL"
    ).fetchone()["c"]
    marked = mark_misdetected(conn)
    for path in marked:
        print(f"marked: {path}")
    if marked:
        _request_rescan(conn)
    conn.commit()
    print(f"{len(marked)} of {total} rows carry bytes their format contradicts — mtime zeroed.")
    print("Run Rescan (Settings → Library) or restart to reprocess them through repair.")


if __name__ == "__main__":
    main()
