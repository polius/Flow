/* UI chrome state. Persisted where chrome shouldn't reset; panel state
   stays session-local. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { QueueOrigin, Track } from "../api/types";

/** "system" follows prefers-color-scheme; light/dark are manual overrides. */
export type ThemeMode = "system" | "light" | "dark";

/** A track action menu request. `origin` is what the queue's "Playing
    from" becomes if the menu's Play starts playback from here.
    `removeFromPlaylist` is set when the row came from a playlist; the
    closure carries the playlist context the menu can't know. Paged views
    also hand over a `contextLoader`: "Play" must queue the whole view,
    never just the pages the window loaded. */
export interface TrackMenuRequest {
  track: Track;
  x: number;
  y: number;
  context?: Track[];
  contextLoader?: () => Promise<Track[]>;
  origin?: QueueOrigin | null;
  removeFromPlaylist?: () => void;
  /** The invoking table's live selection, when the right-clicked row is
      part of it: the menu's file/queue verbs then act on the WHOLE
      selection, not just the row under the pointer. */
  selection?: Track[];
}

/** A one-generation notice: what happened, and the closure that reverses
    it. The toast host renders it; a new notice replaces the old. `undo`
    is optional — stream-error skips borrow the toast's quiet pill to say
    what happened, but there is nothing to un-do. */
export interface UndoNotice {
  id: number;
  message: string;
  undo?: () => Promise<void>;
}

let undoNonce = 0;

interface UiState {
  /** Track currently open in the Get Info panel, if any. */
  getInfoTrackId: number | null;
  openGetInfo: (trackId: number) => void;
  closeGetInfo: () => void;
  /** Full-screen Now Playing takeover; Esc closes. */
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
      Esc precedence and the global shortcut guard defer to it. */
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  /** "Add to Playlist" from anywhere: the tracks a header menu / row menu
      wants to file, and the destination dialog that resolves where.
      Null = closed. */
  addToPlaylistTarget: Track[] | null;
  openAddToPlaylist: (tracks: Track[]) => void;
  closeAddToPlaylist: () => void;
  /** True while a queue row is lifted mid-drag — the drag is a layer above
      the Now Playing takeover, so Esc cancels the drag first. */
  queueDragOpen: boolean;
  setQueueDragOpen: (open: boolean) => void;
  /** Theme override; default follows the OS. */
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  /** The undo toast: destructive-but-recoverable actions land here — one
      notice at a time, single-generation. Recoverable notices carry
      `undo`; stream-error skips use the same quiet pill without it. */
  undoNotice: UndoNotice | null;
  showUndoNotice: (notice: Omit<UndoNotice, "id">) => void;
  clearUndoNotice: () => void;
  /** Bumped to focus the top-bar search field from anywhere (Cmd/Ctrl+F). */
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
      addToPlaylistTarget: null,
      openAddToPlaylist: (addToPlaylistTarget) => set({ addToPlaylistTarget }),
      closeAddToPlaylist: () => set({ addToPlaylistTarget: null }),
      queueDragOpen: false,
      setQueueDragOpen: (queueDragOpen) => set({ queueDragOpen }),
      themeMode: "system",
      setThemeMode: (themeMode) => set({ themeMode }),
      undoNotice: null,
      showUndoNotice: (notice) =>
        set({ undoNotice: { ...notice, id: ++undoNonce } }),
      clearUndoNotice: () => set({ undoNotice: null }),
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
