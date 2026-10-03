-- Tracks rescued from mislabeled containers stream a remuxed copy under
-- DATA_DIR/repaired/ — the library path still points at the untouched
-- original. NULL = normal file, streamed from MUSIC_DIR/path. The scanner
-- rewrites this column on every reprocess, so a replaced original heals or
-- unheals on its own and a vanished copy is re-derived.
ALTER TABLE tracks ADD COLUMN media_path TEXT;
