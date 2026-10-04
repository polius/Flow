-- tracks.title / artist_id / album_id are overlays over the file's tags;
-- user_edited (see scanner.Edited) records which fields the user overrode
-- so a rescan re-applies the overlay after re-reading changed tags. A file
-- that disappears and reappears with the same size + mtime is a move: the
-- row (with user edits) is kept, not deleted + re-added. played_at,
-- favorite, and favorite_position are user state the scanner never touches.
-- Tracks rescued from mislabeled containers stream a remuxed copy under
-- DATA_DIR/repaired/ — media_path points there while path still points at
-- the untouched original. NULL = normal file, streamed from MUSIC_DIR/path.
-- The scanner rewrites media_path on every reprocess, so a replaced original
-- heals or unheals on its own and a vanished copy is re-derived.

CREATE TABLE tracks (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,  -- relative to library root
  media_path      TEXT,                  -- stream override; see note above
  title           TEXT NOT NULL,         -- overlay lives here
  artist_id       INTEGER REFERENCES artists(id),
  album_id        INTEGER REFERENCES albums(id),
  album_artist_id INTEGER REFERENCES artists(id),
  track_no        INTEGER,
  disc_no         INTEGER,
  year            INTEGER,
  duration        REAL NOT NULL,         -- seconds
  format          TEXT NOT NULL,         -- 'mp3' | 'flac' | 'm4a' | 'ogg'
  bitrate         INTEGER,
  sample_rate     INTEGER,
  mtime           REAL NOT NULL,         -- file mtime at last tag read
  size            INTEGER,               -- bytes; move detection during rescan
  gain_db         REAL,                  -- loudness offset (dB) vs Sound Check ref
  played_at       TEXT,                  -- stamped on real playback start; rescan preserves it
  user_edited     INTEGER NOT NULL DEFAULT 0,
  artwork_id      INTEGER REFERENCES artwork(id),
  favorite        INTEGER NOT NULL DEFAULT 0,
  favorite_position INTEGER,             -- 1..n slot in Favorites' manual drag order (NULL = unplaced)
  added_at        TEXT NOT NULL          -- ISO-8601 UTC
);

CREATE TABLE artists (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cover_artwork_id INTEGER REFERENCES artwork(id)  -- user-set portrait; overrides the latest-album cover
);

CREATE TABLE albums (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL COLLATE NOCASE,
  artist_id  INTEGER REFERENCES artists(id),
  year       INTEGER,
  artwork_id INTEGER REFERENCES artwork(id),  -- deduped: cover of first track seen
  cover_artwork_id INTEGER REFERENCES artwork(id)  -- user-set cover; overrides artwork_id (like playlists)
);

-- track_artists: credited artists per track with a role. tracks.artist_id
-- stays the primary display artist; featured/composer credits and additional
-- mains live here so "A feat. B" is browsable from both sides. track_genres
-- is multi-genre membership, parsed from tags at scan.

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

CREATE TABLE playlists (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  created_at       TEXT NOT NULL,
  sort             TEXT NOT NULL DEFAULT 'manual',
  cover_artwork_id INTEGER REFERENCES artwork(id)  -- user-set cover; overrides the 2×2 track mosaic
);

CREATE TABLE playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX idx_playlist_tracks_track ON playlist_tracks(track_id);

CREATE TABLE artwork (
  id   INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,  -- sha1 of image bytes; dedupes covers across tracks
  blob BLOB NOT NULL,
  mime TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_tracks_album        ON tracks(album_id);
CREATE INDEX idx_tracks_artist       ON tracks(artist_id);
CREATE INDEX idx_tracks_album_artist ON tracks(album_artist_id);
CREATE INDEX idx_albums_artist       ON albums(artist_id);

-- Server-truth play queue: queue_items is the queue in the client's
-- insertion order — position is dense 0..n-1 and the whole snapshot is
-- replaced on every plan change, so entries are never renumbered in place.
-- A track removed from the library cascades out, like playlist entries.
-- queue_state is the singleton playhead row: play_order is the play order
-- as a JSON array of queue positions (identity, or the shuffle plan held
-- server-side so every browser sees the same plan); order_pos indexes it
-- (-1 = queue built, nothing loaded); position is seconds into the current
-- track. origin records where the queue came from (kind, human label, and
-- the href that makes the label a link). NULL = a hand-built queue.

CREATE TABLE queue_items (
  position INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE
);
CREATE INDEX idx_queue_items_track ON queue_items(track_id);

CREATE TABLE queue_state (
  id         INTEGER PRIMARY KEY CHECK (id = 0),
  play_order TEXT NOT NULL DEFAULT '[]',
  order_pos  INTEGER NOT NULL DEFAULT -1,
  position   REAL NOT NULL DEFAULT 0,
  updated_at TEXT,
  origin     TEXT
);

INSERT INTO queue_state (id, play_order, order_pos, position) VALUES (0, '[]', -1, 0);
