/* Player state — lives here, outside any view lifecycle, so playback
   continues across navigation (DESIGN.md §9.4).

   Milestone 1: volume persistence only. Transport and queue arrive with
   Milestone 3; the bar renders honest disabled states until then. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RepeatMode = "off" | "all" | "one";

interface PlayerState {
  currentTrackId: number | null;
  isPlaying: boolean;
  volume: number; // 0..1 — applied to the audio element in Milestone 3
  shuffle: boolean;
  repeat: RepeatMode;
  setVolume: (v: number) => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      currentTrackId: null,
      isPlaying: false,
      volume: 0.8,
      shuffle: false,
      repeat: "off",
      setVolume: (v) => set({ volume: Math.min(1, Math.max(0, v)) }),
    }),
    {
      name: "flow.player",
      // Only durable preferences belong in storage; queue/track state is
      // restored separately ("continue listening", DESIGN.md §13.9).
      partialize: (s) => ({ volume: s.volume, shuffle: s.shuffle, repeat: s.repeat }),
    },
  ),
);
