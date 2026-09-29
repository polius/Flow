/* UI chrome state (sidebar collapse, Get Info panel, search focus).
   Persisted where chrome shouldn't reset; panel state stays session-local. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Track currently open in the Get Info panel, if any (§9.3). */
  getInfoTrackId: number | null;
  openGetInfo: (trackId: number) => void;
  closeGetInfo: () => void;
  /** Bumped to focus the search field from anywhere (Cmd/Ctrl+F, §9.5). */
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
      searchFocusSignal: 0,
      focusSearch: () =>
        set((state) => ({ searchFocusSignal: state.searchFocusSignal + 1 })),
    }),
    {
      name: "flow.ui",
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }),
    },
  ),
);
