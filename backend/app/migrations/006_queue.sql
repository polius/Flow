-- 006 — the server-truth play queue (UX review Part 4.0).
--
-- queue_items : the queue itself, in the client's queue (insertion) order.
--               `position` is dense 0..n-1 — the whole snapshot is replaced
--               on every plan change, so entries are never renumbered in
--               place. A track removed from the library cascades out, like
--               playlist entries.
-- queue_state : the singleton playhead row. `play_order` is the play order
--               as a JSON array of queue positions (identity, or the
--               shuffle plan — the client's `order`, held server-side so
--               every browser and every reload sees the same plan).
--               `order_pos` indexes it (-1 = queue built, nothing loaded,
--               the store's own idle convention §23.6); `position` is
--               seconds into the current track.
--
-- Written by POST/PUT/PATCH /api/queue; read by GET /api/queue. The GET
-- self-heals: play_order entries whose track has vanished are dropped and
-- the snapshot is rewritten canonically (DESIGN.md §32).

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
  updated_at TEXT
);

INSERT INTO queue_state (id, play_order, order_pos, position) VALUES (0, '[]', -1, 0);
