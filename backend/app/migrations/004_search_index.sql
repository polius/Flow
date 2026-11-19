-- A word index for search.
--
-- Search used to wrap the whole query in wildcards and LIKE it against one
-- field at a time: "blue hour" matched, "hour blue" and "midnight harbor
-- blue hour" (artist, then title) did not, and LIKE folds case for A-Z only,
-- so "beyonce" never found "Beyoncé".
--
-- track_search holds, per track, the four names a listener types: its
-- title, its artist, its album and the album's artist. The unicode61
-- tokenizer folds case and strips accents on both sides, and the prefix
-- indexes make "blu ho" a cheap query. Matching is by word, in any order,
-- across the four columns (app/search.py builds the queries).
--
-- The index is kept in step by triggers, in plain SQL, so every writer is
-- covered without knowing the index exists: the scanner, the editors, undo,
-- cascading deletes. A track's row is rewritten when its title or the
-- artist/album it points at changes, and when an artist or album it points
-- at is renamed.
--
-- Additive only: nothing existing is altered, and dropping the table and
-- its triggers restores the previous schema exactly.

CREATE VIRTUAL TABLE track_search USING fts5(
  title, artist, album, album_artist,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '1 2 3'
);

INSERT INTO track_search (rowid, title, artist, album, album_artist)
SELECT t.id, t.title, ar.name, al.title, aar.name
FROM tracks t
LEFT JOIN artists ar ON ar.id = t.artist_id
LEFT JOIN albums al ON al.id = t.album_id
LEFT JOIN artists aar ON aar.id = al.artist_id;

CREATE TRIGGER track_search_track_insert AFTER INSERT ON tracks BEGIN
  INSERT INTO track_search (rowid, title, artist, album, album_artist)
  SELECT t.id, t.title, ar.name, al.title, aar.name
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums al ON al.id = t.album_id
  LEFT JOIN artists aar ON aar.id = al.artist_id
  WHERE t.id = NEW.id;
END;

CREATE TRIGGER track_search_track_update
AFTER UPDATE OF title, artist_id, album_id ON tracks BEGIN
  DELETE FROM track_search WHERE rowid = OLD.id;
  INSERT INTO track_search (rowid, title, artist, album, album_artist)
  SELECT t.id, t.title, ar.name, al.title, aar.name
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums al ON al.id = t.album_id
  LEFT JOIN artists aar ON aar.id = al.artist_id
  WHERE t.id = NEW.id;
END;

CREATE TRIGGER track_search_track_delete AFTER DELETE ON tracks BEGIN
  DELETE FROM track_search WHERE rowid = OLD.id;
END;

CREATE TRIGGER track_search_artist_rename AFTER UPDATE OF name ON artists BEGIN
  DELETE FROM track_search WHERE rowid IN (
    SELECT t.id FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
    WHERE t.artist_id = NEW.id OR al.artist_id = NEW.id
  );
  INSERT INTO track_search (rowid, title, artist, album, album_artist)
  SELECT t.id, t.title, ar.name, al.title, aar.name
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums al ON al.id = t.album_id
  LEFT JOIN artists aar ON aar.id = al.artist_id
  WHERE t.artist_id = NEW.id OR al.artist_id = NEW.id;
END;

CREATE TRIGGER track_search_album_update
AFTER UPDATE OF title, artist_id ON albums BEGIN
  DELETE FROM track_search WHERE rowid IN (SELECT id FROM tracks WHERE album_id = NEW.id);
  INSERT INTO track_search (rowid, title, artist, album, album_artist)
  SELECT t.id, t.title, ar.name, al.title, aar.name
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums al ON al.id = t.album_id
  LEFT JOIN artists aar ON aar.id = al.artist_id
  WHERE t.album_id = NEW.id;
END;
