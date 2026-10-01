/* Modal focus management (§3.4): the review found every declared
   aria-modal surface — Now Playing, Organize, Get Info, the dialogs —
   leaving background content live to Tab and focus stranded on close.
   One hook fixes the class of defect everywhere:

   - on open: focus moves into the surface (the container itself, unless a
     caller nominates a better first target — the picker's search field);
   - Tab / Shift+Tab cycle within the surface (the focusable set is
     recomputed per press, so virtualized lists and conditional buttons
     stay honest);
   - on close: focus returns to the element that had it before.

   The container gets tabIndex={-1} if it lacks one, so it can receive
   focus without joining the Tab order; focusing it shows no ring
   (:focus-visible is keyboard-only). */

import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isVisible(el: HTMLElement): boolean {
  return (
    el.getClientRects().length > 0 ||
    (el.offsetWidth > 0 && el.offsetHeight > 0)
  );
}

export function focusablesIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => isVisible(el),
  );
}

export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  opts?: { initial?: () => HTMLElement | null },
): void {
  useEffect(() => {
    if (!active) return;
    const surface = ref.current;
    if (!surface) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (surface.tabIndex === 0) surface.tabIndex = -1;
    if (!surface.contains(document.activeElement)) {
      // The surface's first control takes focus (the picker's search-field
      // precedent); the container itself is the fallback host. Neither is
      // a text field, so the Esc grammar is untouched.
      const initial = opts?.initial?.() ?? focusablesIn(surface)[0] ?? surface;
      initial.focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !surface.isConnected) return;
      const focusables = focusablesIn(surface);
      if (focusables.length === 0) {
        e.preventDefault();
        surface.focus({ preventScroll: true });
        return;
      }
      const current = document.activeElement as HTMLElement | null;
      const index = current != null ? focusables.indexOf(current) : -1;
      const last = focusables.length - 1;
      let next: number;
      if (e.shiftKey) {
        next = index <= 0 ? last : index - 1;
      } else {
        next = index === -1 || index === last ? 0 : index + 1;
      }
      e.preventDefault();
      focusables[next].focus({ preventScroll: true });
    };

    surface.addEventListener("keydown", onKeyDown, true);
    return () => {
      surface.removeEventListener("keydown", onKeyDown, true);
      // Restore focus on close — unless the user's focus already moved
      // somewhere else on its own (don't steal it back). The usual path is
      // unmount, where `surface.isConnected` is false and restoration is
      // unconditional.
      const userMovedOn =
        surface.isConnected && !surface.contains(document.activeElement);
      if (!userMovedOn && previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
    // The caller nominates the initial target per surface; it never changes
    // for a mounted surface, so opts is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
