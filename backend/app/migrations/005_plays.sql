-- A listening history (G2): one row per counted play — after 30 s of
-- listening, or half of a shorter song — so Flow can say what is played
-- most, sort by it, and later look back over a year. tracks.play_count is
-- the per-song total, kept in step by triggers so a sort by plays reads
-- one column.
--
-- Numbered after 004 (the word index): a database is at 5 only after 4
-- has run, so the two must ship in order.
CREATE TABLE plays (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL
);
CREATE INDEX plays_track ON plays (track_id);
CREATE INDEX plays_time ON plays (played_at);

ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER plays_count_insert AFTER INSERT ON plays BEGIN
  UPDATE tracks SET play_count = play_count + 1 WHERE id = NEW.track_id;
END;

CREATE TRIGGER plays_count_delete AFTER DELETE ON plays BEGIN
  UPDATE tracks SET play_count = play_count - 1 WHERE id = OLD.track_id;
END;
