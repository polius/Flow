/* UI chrome state (Get Info panel, search focus, Now Playing takeover, theme
   override). Persisted where chrome shouldn't reset; panel state stays
   session-local. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Track } from "../api/types";

/** "system" follows prefers-color-scheme; light/dark are manual overrides (§8.6). */
export type ThemeMode = "system" | "light" | "dark";

/** A track action menu request: the row's track, its open point (viewport
    coords — the menu positions itself, or falls back to a bottom sheet on
    phones), and the play context it was invoked from. */
export interface TrackMenuRequest {
  track: Track;
  x: number;
  y: number;
  context?: Track[];
}

interface UiState {
  /** Track currently open in the Get Info panel, if any (§9.3). */
  getInfoTrackId: number | null;
  openGetInfo: (trackId: number) => void;
  closeGetInfo: () => void;
  /** Full-screen Now Playing takeover (§9.2); Esc closes. */
  nowPlayingOpen: boolean;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  /** Organize is a task, not a destination: it lives in a full-screen sheet
      over the app (opened from Tracks) instead of its own section. */
  organizeOpen: boolean;
  openOrganize: () => void;
  closeOrganize: () => void;
  /** The row context menu (right-click / long-press / ···): one open menu at
      a time, app-wide. */
  trackMenu: TrackMenuRequest | null;
  openTrackMenu: (request: TrackMenuRequest) => void;
  closeTrackMenu: () => void;
  /** True while any context menu is up — Esc and shortcuts defer to it. */
  contextMenuOpen: boolean;
  setContextMenuOpen: (open: boolean) => void;
  /** True while the library picker (Add to Playlist / Add to Queue) is up —
      Esc precedence and the global shortcut guard defer to it (§23). */
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
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
      getInfoTrackId: null,
      openGetInfo: (trackId) => set({ getInfoTrackId: trackId }),
      closeGetInfo: () => set({ getInfoTrackId: null }),
      nowPlayingOpen: false,
      openNowPlaying: () => set({ nowPlayingOpen: true }),
      closeNowPlaying: () => set({ nowPlayingOpen: false }),
      organizeOpen: false,
      openOrganize: () => set({ organizeOpen: true }),
      closeOrganize: () => set({ organizeOpen: false }),
      trackMenu: null,
      openTrackMenu: (trackMenu) => set({ trackMenu }),
      closeTrackMenu: () => set({ trackMenu: null }),
      contextMenuOpen: false,
      setContextMenuOpen: (contextMenuOpen) => set({ contextMenuOpen }),
      pickerOpen: false,
      setPickerOpen: (pickerOpen) => set({ pickerOpen }),
      themeMode: "system",
      setThemeMode: (themeMode) => set({ themeMode }),
      searchFocusSignal: 0,
      focusSearch: () =>
        set((state) => ({ searchFocusSignal: state.searchFocusSignal + 1 })),
    }),
    {
      name: "flow.ui",
      partialize: (s) => ({
        themeMode: s.themeMode,
      }),
    },
  ),
);
