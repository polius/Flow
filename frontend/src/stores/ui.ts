/* UI chrome state (sidebar collapse, Get Info panel, search focus, Now Playing
   takeover, theme override). Persisted where chrome shouldn't reset; panel
   state stays session-local. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** "system" follows prefers-color-scheme; light/dark are manual overrides (§8.6). */
export type ThemeMode = "system" | "light" | "dark";

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Track currently open in the Get Info panel, if any (§9.3). */
  getInfoTrackId: number | null;
  openGetInfo: (trackId: number) => void;
  closeGetInfo: () => void;
  /** Full-screen Now Playing takeover (§9.2); Esc closes. */
  nowPlayingOpen: boolean;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  /** True while any context menu is up — Esc and shortcuts defer to it. */
  contextMenuOpen: boolean;
  setContextMenuOpen: (open: boolean) => void;
  /** Theme override; default follows the OS (§8.6). */
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  /** Bumped to focus the top-bar search field from anywhere (Cmd/Ctrl+F, §9.5). */
  searchFocusSignal: number;
  focusSearch: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      getInfoTrackId: null,
      openGetInfo: (trackId) => set({ getInfoTrackId: trackId }),
      closeGetInfo: () => set({ getInfoTrackId: null }),
      nowPlayingOpen: false,
      openNowPlaying: () => set({ nowPlayingOpen: true }),
      closeNowPlaying: () => set({ nowPlayingOpen: false }),
      contextMenuOpen: false,
      setContextMenuOpen: (contextMenuOpen) => set({ contextMenuOpen }),
      themeMode: "system",
      setThemeMode: (themeMode) => set({ themeMode }),
      searchFocusSignal: 0,
      focusSearch: () =>
        set((state) => ({ searchFocusSignal: state.searchFocusSignal + 1 })),
    }),
    {
      name: "flow.ui",
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        themeMode: s.themeMode,
      }),
    },
  ),
);
