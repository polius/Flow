/* Keyboard movement through a grid of cover cards. Each card is ONE Tab
   stop (its cover link); the arrows move between cards, the way they move
   between rows in a song table — a wall of 500 albums is not 2,000 Tab
   presses. Left and Right follow the reading order; Up and Down go to the
   card above or below, found by position, so it works whatever the column
   count is and inside a windowed grid's rows. */

import { useEffect, useRef, type KeyboardEvent, type FocusEvent, type RefObject } from "react";

import { isMenuKey } from "./rowCursor";

const CARD_LINK = ".album-card__artlink";

/** Move focus from `from` (a card's cover link) for an arrow key. Returns
    true when the key was an arrow that found somewhere to go. */
export function moveCardFocus(from: HTMLElement, key: string): boolean {
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown")
    return false;
  // The grid: the nearest container that holds more than this card.
  const grid = from.closest(".cardgrid, .covergrid") ?? document.body;
  const links = [...grid.querySelectorAll<HTMLElement>(CARD_LINK)];
  const at = links.indexOf(from);
  if (at < 0) return false;

  let target: HTMLElement | undefined;
  if (key === "ArrowLeft") target = links[at - 1];
  else if (key === "ArrowRight") target = links[at + 1];
  else {
    const here = from.getBoundingClientRect();
    const down = key === "ArrowDown";
    let best = Infinity;
    for (const link of links) {
      const r = link.getBoundingClientRect();
      const dy = down ? r.top - here.top : here.top - r.top;
      if (dy < here.height / 2) continue; // not in a row beyond this one
      // The nearest row first, then the nearest column in it.
      const score = dy * 1000 + Math.abs(r.left - here.left);
      if (score < best) {
        best = score;
        target = link;
      }
    }
  }
  if (!target) return false;
  target.focus();
  target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return true;
}

/** A cover card's keyboard: the cover link is its one Tab stop, the arrows
    move between cards, and Shift+F10 or the Menu key opens the card's menu
    (the pointer's "…") with focus on its first item. In the menu, Up and
    Down walk the items; Esc gives focus back to the cover; Tab out of the
    menu closes it. `menuRef` holds the menu (or a wrapper around it). */
export function useCardKeys(
  menuOpen: boolean,
  setMenuOpen: (open: boolean) => void,
  menuRef: RefObject<HTMLElement | null>,
) {
  const coverRef = useRef<HTMLAnchorElement>(null);
  const openedByKey = useRef(false);

  useEffect(() => {
    if (!openedByKey.current) return;
    if (menuOpen) {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    } else {
      openedByKey.current = false;
      coverRef.current?.focus(); // closed: back to where the keyboard was
    }
  }, [menuOpen, menuRef]);

  const onCoverKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      openedByKey.current = true;
      setMenuOpen(true);
      return;
    }
    if (moveCardFocus(e.currentTarget, e.key)) e.preventDefault();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
    ];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
    items[next].focus();
  };

  const onMenuBlur = (e: FocusEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    if (!openedByKey.current || e.relatedTarget == null) return;
    openedByKey.current = false; // focus went somewhere on purpose: leave it there
    setMenuOpen(false);
  };

  return { coverRef, onCoverKeyDown, onMenuKeyDown, onMenuBlur };
}
