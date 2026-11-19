-- One queue, several devices (P3). `device` is the browser that holds the
-- queue: the one that last started it, played it, or took it over. A
-- write from another device is refused (409) so that device can say
-- "Playing on another device" instead of silently overwriting. Shuffle
-- and repeat travel with the queue, so a second device shows the same
-- plan with the same switches.
ALTER TABLE queue_state ADD COLUMN device TEXT;
-- NULL until a device states them: an upgraded queue keeps each browser's
-- own Shuffle and Repeat instead of resetting them to off.
ALTER TABLE queue_state ADD COLUMN shuffle INTEGER;
ALTER TABLE queue_state ADD COLUMN repeat TEXT;
