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

/** ARIA widget roles: an element wearing one is a control, whatever its
    tag — a focused `role=button` queue row owns Space like a <button>. */
const WIDGET_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
  "combobox",
]);

/** The broader guard for Space/arrows: any interactive control keeps its
    native key behavior. A focusable container (tabindex) that is not a
    widget — the track tables' single Tab stop — is not a control: Space
    there is still play/pause. */
export function isInteractiveControl(el: Element | null): boolean {
  if (isTextEditingTarget(el)) return true;
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return true;
  const role = el.getAttribute("role");
  return role != null && WIDGET_ROLES.has(role);
}

/** The last <button> a pointer pressed. Focus stays on a clicked button,
    and Space would press it AGAIN (Next, Shuffle…) — after a mouse click,
    Space means play/pause; a button reached by keyboard keeps Space. */
let pointerPressedButton: Element | null = null;

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      pointerPressedButton =
        e.target instanceof Element ? e.target.closest("button") : null;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // A handler closer to the focus already acted on this key (a queue
      // row's own Space plays it): never act twice.
      if (e.defaultPrevented) return;
      // Keyboard navigation hands the button back to the keyboard.
      if (e.key === "Tab") pointerPressedButton = null;
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
      const active = document.activeElement;
      // A button the mouse just clicked doesn't own Space (see above).
      const clickedButton =
        e.key === " " && active != null && active === pointerPressedButton;
      if (!clickedButton && isInteractiveControl(active)) return;
      // The library picker is a modal: Space/arrows belong to it.
      if (useUiStore.getState().pickerOpen) return;

      const player = usePlayerStore.getState();
      const ui = useUiStore.getState();
      const hasQueue = player.queue.length > 0;

      // Any open menu owns the keyboard until it's dismissed.
      if (ui.contextMenuOpen) return;

      switch (e.key) {
        case " ": {
          // Held Space auto-repeats: one press, one toggle.
          e.preventDefault();
          if (e.repeat) return;
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

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}

/* ---- discovery keys: ? · / · L ------------------------------------------
   Self-contained on purpose (its own listener, its own guard) so it never
   tangles with the transport handler above. Letters only fire with no
   modifier and never while text is being edited; open menus and modal
   surfaces keep the keyboard. A focused button does NOT block them —
   unlike Space, a letter has no native meaning on a button.
     ?  the shortcut sheet (toggles)
     /  focus the search field (the ⌘F twin, one key)
     L  love / unlove the playing song */

export function useDiscoveryShortcuts(actions: {
  helpOpen: boolean;
  toggleHelp: () => void;
  toggleFavorite: () => void;
}): void {
  const { helpOpen, toggleHelp, toggleFavorite } = actions;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTextEditingTarget(document.activeElement)) return;
      const ui = useUiStore.getState();
      if (ui.contextMenuOpen) return;
      // The sheet itself registers as a modal (pickerOpen): "?" still
      // closes it; any OTHER open modal keeps the key.
      if (e.key === "?") {
        if (ui.pickerOpen && !helpOpen) return;
        e.preventDefault();
        toggleHelp();
        return;
      }
      if (ui.pickerOpen) return;
      if (e.key === "/") {
        e.preventDefault();
        ui.focusSearch();
        return;
      }
      if ((e.key === "l" || e.key === "L") && !e.shiftKey) {
        e.preventDefault();
        toggleFavorite();
      }
    };
    // Settings' "Show" button opens the same sheet (openShortcutSheet).
    const onOpenRequest = () => {
      if (!helpOpen) toggleHelp();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(SHEET_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(SHEET_EVENT, onOpenRequest);
    };
  }, [helpOpen, toggleHelp, toggleFavorite]);
}

const SHEET_EVENT = "flow:shortcut-sheet";

/** Open the shortcut sheet from a control (the "?" key's pointer twin). */
export function openShortcutSheet(): void {
  window.dispatchEvent(new Event(SHEET_EVENT));
}
