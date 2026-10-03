-- Self-healing scan (DESIGN.md §38): tracks rescued from mislabeled
-- containers stream a remuxed copy under DATA_DIR/repaired/ — the library
-- path still points at the untouched original. NULL = normal file, streamed
-- from MUSIC_DIR/path. The scanner rewrites this column every time it
-- reprocesses the file, so an original the user replaces heals or unheals
-- on its own, and a vanished copy (data dir cleaned) is re-derived.
ALTER TABLE tracks ADD COLUMN media_path TEXT;
