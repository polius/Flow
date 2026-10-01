-- 008 — the queue's origin (UX review 2, Part 1.1 / DESIGN.md §33).
--
-- queue_state gains one nullable JSON column: WHERE the queue came from —
-- kind (album / artist / playlist / filter / shuffle-all / manual), a human
-- label ("Album 03", "Everything, shuffled"), and the href that makes the
-- label a link. The caller knows what it is the moment it asks for a queue;
-- recording it here is what lets the drawer say "Playing from …" and the
-- queue body group itself by album. NULL = a hand-built queue (the §23
-- convention: nothing renders, exactly as today).

ALTER TABLE queue_state ADD COLUMN origin TEXT;
