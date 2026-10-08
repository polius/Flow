"""One-shot heal for libraries indexed before the ISO-BMFF misparse fix.

Stream-rips (fragmented MP4/DASH bytes behind an ID3v2 tag, named .mp3) were
indexed as format=mp3 when mutagen's frame-sync hunt validated decoy headers.
Such rows stream audio/mpeg carrying MP4 and fail in browsers. This script
sniffs every mp3 row's payload once and zeroes the mtime of the ftyp-carrying
ones, so the next scan reclassifies them as changed and reprocesses them
through the repair path (strip junk, remux, index the copy's format).

Run inside the container, then trigger Rescan (Settings → Library):

    docker exec <container> python -m app.heal

Originals are never modified; only the rows' stored mtime changes.
"""

from __future__ import annotations

from app import config
from app.db import Database
from app.tags import iso_bmff_offset


def main() -> None:
    db = Database(config.DB_PATH)
    db.init()  # idempotent: standalone run must not depend on app startup
    conn = db.connect()
    rows = conn.execute(
        "SELECT id, path FROM tracks WHERE format = 'mp3'"
    ).fetchall()
    marked = 0
    for row in rows:
        if iso_bmff_offset(config.MUSIC_DIR / row["path"]) is not None:
            conn.execute(
                "UPDATE tracks SET mtime = 0 WHERE id = ?", (row["id"],)
            )
            marked += 1
            print(f"marked: {row['path']}")
    conn.commit()
    print(
        f"{marked} of {len(rows)} mp3 rows carry ISO-BMFF bytes — mtime zeroed."
    )
    print("Run Rescan (Settings → Library) to reprocess them through repair.")


if __name__ == "__main__":
    main()
