/* Global keyboard shortcuts (§9.5): Space play/pause, ←/→ seek ±10s,
   ↑/↓ volume. ⌘/Ctrl+F and Esc already exist and stay where they are
   (§15.7): ⌘F in AppShell, Esc in the individual surfaces.

   Two guards, two jobs (§29 — the old single "typing target" guard also
   listed buttons and links, which made Esc fail whenever any control held
   focus — in a pointer UI that is almost always):
   - Space/arrows yield to ANY focused interactive control — inputs,
     textareas, selects, buttons, links, sliders — so native activation
     (Space on a focused button, arrows on a slider) is preserved and
     nothing double-fires. That is the "must not fire while typing" rule.
   - Esc defers only while focus sits in TEXT mid-edit (input, textarea,
     contenteditable), where Esc means "cancel the edit". A focused button
     or link never defers: Esc always closes the topmost surface. */

import { useEffect } from "react";

import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

const VOLUME_STEP = 0.05;
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
    // belongs to the frontmost surface (§29).
    return type === "" || TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/** The broader guard for Space/arrows: any interactive control keeps its
    native key behavior (§16.3, revised §29). */
export function isInteractiveControl(el: Element | null): boolean {
  if (isTextEditingTarget(el)) return true;
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "BUTTON" || tag === "A";
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Modifier chords belong to browser and app shortcuts (⌘F, ⌘R, …).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isInteractiveControl(document.activeElement)) return;
      // The library picker is a modal (§23): Space/arrows belong to it.
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
        case "ArrowUp": {
          e.preventDefault();
          player.setVolume(player.volume + VOLUME_STEP);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          player.setVolume(player.volume - VOLUME_STEP);
          break;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
