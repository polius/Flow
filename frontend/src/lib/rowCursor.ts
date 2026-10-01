/* Finder-style keyboard cursor for the listening tables (§3.4): the review
   found track rows unreachable as a table — inner buttons tabbable, but no
   arrow-key cursor and no Enter-to-play, while the Organize grid implements
   exactly that grammar. The listening tables inherit it:

   - the table container is ONE Tab stop; arrows move the cursor,
     Home/End jump, PageUp/PageDown page, Enter plays the cursor row;
   - keys never fire while focus sits on an inner control (button, link,
     slider) — the same guard the Organize grid uses (§16.3), so nothing
     double-fires;
   - Space stays with the global transport shortcut (play/pause), which is
     the app-wide grammar.

   The cursor is visual + keyboard state; the row buttons remain the
   pointer and screen-reader path. */

import { useEffect, useState, type KeyboardEvent } from "react";

import { isInteractiveControl } from "./shortcuts";

/** Rows per PageUp/PageDown, matching the Organize grid. */
const PAGE_STEP = 20;

export function useRowCursor(
  count: number,
  onActivate: (index: number) => void,
): {
  cursor: number | null;
  onKeyDown: (e: KeyboardEvent) => void;
} {
  const [cursor, setCursor] = useState<number | null>(null);

  // The view can shrink under a live cursor (filter typed, track removed,
  // navigation): clamp instead of pointing at nothing.
  useEffect(() => {
    setCursor((c) => {
      if (c == null) return c;
      if (count === 0) return null;
      return Math.min(c, count - 1);
    });
  }, [count]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (isInteractiveControl(e.target as Element | null)) return;
    if (count === 0) return;
    const last = count - 1;
    const at = cursor ?? -1;
    const move = (next: number) => {
      e.preventDefault();
      setCursor(Math.max(0, Math.min(last, next)));
    };
    switch (e.key) {
      case "ArrowDown":
        move(at + 1);
        break;
      case "ArrowUp":
        move(at <= 0 ? 0 : at - 1);
        break;
      case "PageDown":
        move(at + PAGE_STEP);
        break;
      case "PageUp":
        move(at - PAGE_STEP);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(last);
        break;
      case "Enter":
        if (at >= 0) {
          e.preventDefault();
          onActivate(at);
        }
        break;
    }
  };

  return { cursor, onKeyDown };
}
