/* Global transport shortcuts. Two guards: Space/arrows yield to ANY
   focused interactive control (native activation preserved, nothing
   double-fires); Esc defers only while focus sits in text mid-edit —
   a focused button never defers. The transport chords run BEFORE the
   modifier early-return, which guards plain Space/arrows from firing
   under a modifier; in text fields ⌘→ means "end of line", and open
   surfaces own the keyboard until dismissed. */

import { useEffect } from "react";

import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

const SEEK_STEP = 10;

/** Input types that carry text — the only focus from which Esc defers. */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
]);

/** True when focus sits in text mid-edit: Esc means "cancel the edit"
    there, so surface-dismissal handlers defer to the field. */
export function isTextEditingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    // Range/checkbox/button-ish inputs are controls, not text: Esc still
    // belongs to the frontmost surface.
    return type === "" || TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/** The broader guard for Space/arrows: any interactive control keeps its
    native key behavior. */
export function isInteractiveControl(el: Element | null): boolean {
  if (isTextEditingTarget(el)) return true;
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "BUTTON" || tag === "A";
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The transport chords — ⌘/Ctrl+→ next, ⌘/Ctrl+← previous — are
      // tested BEFORE the modifier early-return, which would otherwise
      // swallow them (it guards plain Space/arrows from firing under a
      // modifier; the chords ARE the modifier). Text keeps ⌘→ as "end of
      // line"; open surfaces keep the keyboard.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (isTextEditingTarget(document.activeElement)) return;
        const ui = useUiStore.getState();
        if (ui.pickerOpen || ui.contextMenuOpen) return;
        if (e.key === "ArrowRight") {
          e.preventDefault(); // the browser owns ⌘←/⌘→ as history navigation
          usePlayerStore.getState().next();
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          usePlayerStore.getState().prev();
          return;
        }
        return; // other chords (⌘F, ⌘R, …) stay where they are
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isInteractiveControl(document.activeElement)) return;
      // The library picker is a modal: Space/arrows belong to it.
      if (useUiStore.getState().pickerOpen) return;

      const player = usePlayerStore.getState();
      const ui = useUiStore.getState();
      const hasQueue = player.queue.length > 0;

      // Any open menu owns the keyboard until it's dismissed.
      if (ui.contextMenuOpen) return;

      switch (e.key) {
        case " ": {
          e.preventDefault();
          player.togglePlay();
          break;
        }
        case "ArrowRight": {
          if (!hasQueue || player.duration === 0) return;
          e.preventDefault();
          player.seek(Math.min(player.duration, player.position + SEEK_STEP));
          break;
        }
        case "ArrowLeft": {
          if (!hasQueue) return;
          e.preventDefault();
          player.seek(Math.max(0, player.position - SEEK_STEP));
          break;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
