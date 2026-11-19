-- Listens waiting to be sent to ListenBrainz (G3). A counted play is
-- queued only while a ListenBrainz token is set; a sent one leaves the
-- queue. A failed send stays, with its next attempt pushed back, so a
-- server with no internet never blocks playback and catches up later.
CREATE TABLE listenbrainz_queue (
  play_id INTEGER PRIMARY KEY REFERENCES plays(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try REAL NOT NULL DEFAULT 0
);
