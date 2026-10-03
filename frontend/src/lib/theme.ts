/* The resolved theme lands in data-theme on <html>; tokens.css owns what
   each value looks like. index.html carries a matching inline boot snippet
   so the first paint already has the right theme. */

import { useUiStore, type ThemeMode } from "../stores/ui";

const QUERY = "(prefers-color-scheme: dark)";

export function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  const systemDark = window.matchMedia(QUERY).matches;
  return mode === "dark" || (mode === "system" && systemDark) ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolvedTheme(mode);
}

let initialized = false;

export function initTheme(): void {
  if (initialized) return;
  initialized = true;
  applyTheme(useUiStore.getState().themeMode);

  // OS-level changes re-resolve while in "system"; a manual override switches
  // the mode. One listener each, installed once.
  window.matchMedia(QUERY).addEventListener("change", () => {
    applyTheme(useUiStore.getState().themeMode);
  });
  useUiStore.subscribe((state, prev) => {
    if (state.themeMode !== prev.themeMode) applyTheme(state.themeMode);
  });
}
