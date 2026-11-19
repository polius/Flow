/* What a cover card (album, playlist) needs on touch, where there is no
   hover to reveal its Play and "…" buttons and the cover is left alone:
   a long press on the art opens the card's menu — the gesture song rows
   already use. The menu itself is components/CardMenu.tsx. */

import { useRef } from "react";

/** Devices whose primary input cannot hover (library.css hides the cover
    buttons under the same query). */
export const TOUCH_MQ = "(hover: none)";

const LONG_PRESS_MS = 480;
const LONG_PRESS_MOVE_PX = 10;

/** Handlers for the card's art wrapper: fire `open` after a held touch,
    and swallow what the hold leaves behind — the click that would follow
    the link, and the browser's own long-press menu. */
export function useCardLongPress(open: () => void) {
  const press = useRef<{ timer: number | null; x: number; y: number; fired: boolean }>({
    timer: null,
    x: 0,
    y: 0,
    fired: false,
  });
  const clear = () => {
    if (press.current.timer != null) {
      window.clearTimeout(press.current.timer);
      press.current.timer = null;
    }
  };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      clear();
      press.current = { timer: null, x: t.clientX, y: t.clientY, fired: false };
      press.current.timer = window.setTimeout(() => {
        press.current.timer = null;
        press.current.fired = true;
        open();
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (press.current.timer == null) return;
      const t = e.touches[0];
      const dx = t.clientX - press.current.x;
      const dy = t.clientY - press.current.y;
      // Any real movement cancels: scrolling the grid is not a menu request.
      if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
    onClickCapture: (e: React.MouseEvent) => {
      if (!press.current.fired) return;
      press.current.fired = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu: (e: React.MouseEvent) => {
      // A touch hold raises the browser's link menu on some phones; the
      // card's own menu is the answer to that gesture. A mouse right-click
      // keeps the browser's (press is only ever armed by a touch).
      if (press.current.timer != null || press.current.fired) e.preventDefault();
    },
  };
}

/** True when a pointer event landed inside a card menu's sheet — the
    card's "outside tap closes" listener must not treat its own portaled
    menu as outside. */
export function inCardSheet(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".tracksheet") != null;
}
