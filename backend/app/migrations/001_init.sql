-- Initial schema (DESIGN.md §5).
--
-- tracks.title / artist_id / album_id are overlays over the file's tags.
-- user_edited is a bitmask recording which fields the user overrode
--   (1 = title, 2 = artist, 4 = album, 8 = track_no) so a rescan can
--   re-apply the overlay after re-reading changed tags.

CREATE TABLE tracks (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,  -- relative to library root
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
  user_edited     INTEGER NOT NULL DEFAULT 0,
  artwork_id      INTEGER REFERENCES artwork(id),
  favorite        INTEGER NOT NULL DEFAULT 0,
  added_at        TEXT NOT NULL          -- ISO-8601 UTC
);

CREATE TABLE artists (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE albums (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL COLLATE NOCASE,
  artist_id  INTEGER REFERENCES artists(id),
  year       INTEGER,
  artwork_id INTEGER REFERENCES artwork(id)  -- deduped: cover of first track seen
);

CREATE TABLE playlists (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  sort        TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);

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
CREATE INDEX idx_playlist_tracks_track ON playlist_tracks(track_id);
