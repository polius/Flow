-- Track file size (bytes). Used to detect moved files during rescans:
-- a file that disappeared and reappears with the same size + mtime is a
-- move, and its row (with user edits) is kept, not deleted + re-added
-- (DESIGN.md §13.7).

ALTER TABLE tracks ADD COLUMN size INTEGER;
