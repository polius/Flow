-- 005 — media intelligence (UX review Part 2: §2.2, §2.3).
--
-- tracks.gain_db    : per-track loudness offset in dB relative to the
--                     Sound Check reference (computed at scan time; NULL =
--                     not yet analyzed → play at unity gain).
-- track_artists     : credited artists per track with a role. The single
--                     tracks.artist_id stays the *primary* display artist;
--                     featured/composer credits and additional mains live
--                     here so "A feat. B" is browsable from both sides.
-- track_genres      : multi-genre membership, parsed from tags at scan.
--
-- Backfill: every existing track's primary artist becomes its 'main'
-- credit, so the join table starts consistent with the old model.

ALTER TABLE tracks ADD COLUMN gain_db REAL;

CREATE TABLE track_artists (
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'main',  -- 'main' | 'featured' | 'composer'
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, artist_id, role)
);
CREATE INDEX idx_track_artists_artist ON track_artists(artist_id);

CREATE TABLE genres (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE track_genres (
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (track_id, genre_id)
);
CREATE INDEX idx_track_genres_genre ON track_genres(genre_id);

INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position)
  SELECT id, artist_id, 'main', 0 FROM tracks WHERE artist_id IS NOT NULL;
