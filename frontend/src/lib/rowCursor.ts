/* Finder-style keyboard cursor for the listening tables: the container is
   ONE Tab stop — arrows move the cursor, Home/End jump, PageUp/PageDown
   page, Enter plays. Keys never fire while focus sits on an inner control
   (the shared guard below), so nothing double-fires; Space stays with the
   global transport shortcut. The cursor is visual + keyboard state (the
   table points aria-activedescendant at it); the row buttons remain the
   pointer path.

   Two optional verbs ride the same handler:
   - onMenu: Shift+F10 or the ContextMenu key opens the row menu — for the
     row holding focus when focus sits on one of its controls, else for the
     cursor row. Keyboard users get everything right-click offers.
   - onMove: Alt+↑/↓ moves the cursor row one slot (reorderable tables),
     the queue's pointer-free reorder grammar; the cursor travels with it. */

import { useEffect, useState, type KeyboardEvent } from "react";

import { isInteractiveControl } from "./shortcuts";

/** Rows per PageUp/PageDown, matching the Organize grid. */
const PAGE_STEP = 20;

export interface RowCursorOptions {
  onMenu?: (index: number) => void;
  onMove?: (from: number, to: number) => void;
}

/** True for the two keyboard spellings of "open the context menu". */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
}

/** Where a keyboard-opened row menu anchors: under the row's "…" button
    when it is laid out, else under the row's leading edge. */
export function rowMenuPoint(
  container: HTMLElement | null,
  index: number,
): { x: number; y: number } {
  const row = container?.querySelector<HTMLElement>(`[data-rowindex="${index}"]`);
  const more = row?.querySelector<HTMLElement>(".trackrow__more");
  const moreRect = more?.getBoundingClientRect();
  const rect = moreRect && moreRect.width > 0 ? moreRect : row?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: rect.left, y: rect.bottom + 4 };
}

export function useRowCursor(
  count: number,
  onActivate: (index: number) => void,
  options: RowCursorOptions = {},
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
    if (count === 0) return;
    // The menu keys work from inner controls too: they name the row the
    // focused control lives in.
    if (options.onMenu && isMenuKey(e)) {
      const row = (e.target as Element | null)?.closest?.("[data-rowindex]");
      const index = row != null ? Number(row.getAttribute("data-rowindex")) : cursor;
      if (index != null && index >= 0 && index < count) {
        e.preventDefault();
        if (row != null) setCursor(index);
        options.onMenu(index);
      }
      return;
    }
    if (isInteractiveControl(e.target as Element | null)) return;
    const last = count - 1;
    const at = cursor ?? -1;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!options.onMove || at < 0) return;
      const to = e.key === "ArrowUp" ? at - 1 : at + 1;
      e.preventDefault();
      if (to < 0 || to > last) return;
      options.onMove(at, to);
      setCursor(to);
      return;
    }
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
