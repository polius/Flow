-- Playlist tags are gone: the Manage dialog no longer edits them and the
-- API no longer exposes or matches them. Drop the column (003 added it).
ALTER TABLE playlists DROP COLUMN tags;
