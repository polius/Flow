/* Global keyboard shortcuts (§9.5): Space play/pause, ←/→ seek ±10s,
   ↑/↓ volume. ⌘/Ctrl+F and Esc already exist and stay where they are
   (§15.7): ⌘F in AppShell, Esc in the individual surfaces.

   Shortcuts yield whenever focus sits in an interactive control — inputs,
   textareas, contenteditable (inline rename), buttons, links, sliders.
   That is the "must not fire while typing" rule (§9.5), and it also keeps
   native Space-on-button / arrow-on-slider behavior intact. */

import { useEffect } from "react";

import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

const VOLUME_STEP = 0.05;
const SEEK_STEP = 10;

export function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "BUTTON" ||
    tag === "A" ||
    el.isContentEditable
  );
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Modifier chords belong to browser and app shortcuts (⌘F, ⌘R, …).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      // The library picker is a modal (§23): Space/arrows belong to it.
      if (useUiStore.getState().pickerOpen) return;

      const player = usePlayerStore.getState();
      const hasQueue = player.queue.length > 0;

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
