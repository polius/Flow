-- Playlist metadata for the Manage dialog (§9.2):
-- tags — JSON array of strings, canonical form owned by the API
--        (trimmed, deduped case-insensitively).
-- cover_artwork_id — user-set cover (content-addressed `artwork` row);
--        overrides the 2×2 track mosaic while set.

ALTER TABLE playlists ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE playlists ADD COLUMN cover_artwork_id INTEGER REFERENCES artwork(id);
