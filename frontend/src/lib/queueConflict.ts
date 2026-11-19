/* The server refused a queue write because another device holds the
   queue (P3, a 409). The API layer reports it here; the player store
   listens. A module of its own so neither imports the other for it. */

/** `acted`: the refused write followed the listener acting on this
    device (play, skip, pick a song): it should take the queue over. */
let handler: ((acted: boolean) => void) | null = null;

export function setQueueConflictHandler(fn: ((acted: boolean) => void) | null): void {
  handler = fn;
}

export function reportQueueConflict(acted = false): void {
  handler?.(acted);
}
