-- 007 — tracks.played_at (UX review Part 4.1): private, count-free recency.
--
-- One timestamp per track, set when the track actually starts playing. No
-- counts, no charts (§1's non-goal stands) — this is the server-side
-- completion of §13.9's "recently played / continue listening" concession,
-- so the record survives the browser that played it.
--
-- Overlay-consistent: the scanner's upsert sets a fixed column list and
-- never touches played_at — a rescan preserves it exactly like `favorite`.

ALTER TABLE tracks ADD COLUMN played_at TEXT;
