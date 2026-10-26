-- Unicode-aware lookup keys for artists and albums.
--
-- `COLLATE NOCASE` only folds ASCII, so "Beyoncé", its NFD spelling and
-- "BEYONCÉ" became three artists. name_key / title_key hold
-- casefold(NFC(name)) and are what entities.find_or_create_* look up by.
-- SQLite can't compute NFC or casefold, so the keys are backfilled in Python
-- (entities.backfill_name_keys, run at startup and at every scan start;
-- idempotent — it only touches rows whose key is still NULL, which also
-- covers rows written by an older release after a rollback).
--
-- The indexes are deliberately NOT unique: existing libraries can already
-- hold rows that collide under the new key, and a UNIQUE index would fail
-- this migration on real data. Lookups pick the lowest id among equal keys,
-- so they stay deterministic; duplicates fold away as their tracks are
-- rescanned and the orphans are pruned.
--
-- Additive only: older releases ignore the new columns.

ALTER TABLE artists ADD COLUMN name_key TEXT;
ALTER TABLE albums ADD COLUMN title_key TEXT;

CREATE INDEX IF NOT EXISTS idx_artists_name_key ON artists(name_key);
CREATE INDEX IF NOT EXISTS idx_albums_title_key ON albums(title_key, artist_id);
