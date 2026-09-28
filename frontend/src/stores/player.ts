/* Player state + audio engine — one module, deliberately.
   The <audio> element lives outside React's lifecycle so playback continues
   across navigation (DESIGN.md §9.4). Store holds state; the thin engine
   layer below the store binds element events back into it. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Track } from "../api/types";

export type RepeatMode = "off" | "all" | "one";

interface PlayerState {
  queue: Track[];
  order: number[]; // positions into queue (identity, or shuffled)
  orderPos: number; // index into order
  isPlaying: boolean;
  position: number; // seconds
  duration: number; // seconds (from the audio element once known)
  buffered: number; // seconds buffered ahead
  volume: number; // 0..1
  shuffle: boolean;
  repeat: RepeatMode;

  playTracks: (tracks: Track[], startIndex: number) => void;
  playNext: (track: Track) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setShuffle: (on: boolean) => void;
  cycleRepeat: () => void;
}

export function useCurrentTrack(): Track | null {
  return usePlayerStore((s) => s.queue[s.order[s.orderPos]] ?? null);
}

function buildOrder(
  count: number,
  shuffle: boolean,
  startIndex: number,
): { order: number[]; pos: number } {
  if (count === 0) return { order: [], pos: 0 };
  if (!shuffle) {
    return { order: Array.from({ length: count }, (_, i) => i), pos: startIndex };
  }
  const rest = Array.from({ length: count }, (_, i) => i).filter(
    (i) => i !== startIndex,
  );
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return { order: [startIndex, ...rest], pos: 0 };
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      order: [],
      orderPos: 0,
      isPlaying: false,
      position: 0,
      duration: 0,
      buffered: 0,
      volume: 0.8,
      shuffle: false,
      repeat: "off",

      playTracks: (tracks, startIndex) => {
        if (tracks.length === 0) return;
        const clamped = Math.min(Math.max(startIndex, 0), tracks.length - 1);
        const { order, pos } = buildOrder(tracks.length, get().shuffle, clamped);
        set({ queue: tracks, order, orderPos: pos });
        load(tracks[order[pos]], true);
      },

      playNext: (track) => {
        const { queue, order, orderPos, shuffle } = get();
        if (queue.length === 0) {
          get().playTracks([track], 0);
          return;
        }
        const currentQueueIndex = order[orderPos];
        const newQueue = [...queue];
        newQueue.splice(currentQueueIndex + 1, 0, track);
        const rebuilt = buildOrder(newQueue.length, shuffle, currentQueueIndex);
        // Seamless: the audio element keeps playing; only the plan changes.
        set({ queue: newQueue, order: rebuilt.order, orderPos: rebuilt.pos });
      },

      togglePlay: () => {
        if (!audio || get().queue.length === 0) return;
        if (audio.paused) {
          void audio.play().catch(() => set({ isPlaying: false }));
        } else {
          audio.pause();
        }
      },

      next: () => advance(1, false),
      prev: () => {
        if (get().position > 3) {
          get().seek(0);
          return;
        }
        advance(-1, false);
      },

      seek: (seconds) => {
        if (!audio) return;
        audio.currentTime = seconds;
        set({ position: seconds });
      },

      setVolume: (v) => {
        const volume = Math.min(1, Math.max(0, v));
        if (audio) audio.volume = volume;
        set({ volume });
      },

      setShuffle: (on) => {
        const { queue, order, orderPos } = get();
        const currentQueueIndex = order[orderPos] ?? 0;
        const rebuilt = buildOrder(queue.length, on, currentQueueIndex);
        set({ shuffle: on, order: rebuilt.order, orderPos: rebuilt.pos });
      },

      cycleRepeat: () => {
        const modes: RepeatMode[] = ["off", "all", "one"];
        const next = modes[(modes.indexOf(get().repeat) + 1) % modes.length];
        set({ repeat: next });
      },
    }),
    {
      name: "flow.player",
      // Durable preferences only; queue/position are session state.
      partialize: (s) => ({ volume: s.volume, shuffle: s.shuffle, repeat: s.repeat }),
    },
  ),
);

/* ---- audio engine ------------------------------------------------------- */

const audio: HTMLAudioElement | null =
  typeof window !== "undefined" ? new Audio() : null;

function load(track: Track, autoplay: boolean): void {
  if (!audio) return;
  audio.src = `/api/stream/${track.id}`;
  usePlayerStore.setState({ position: 0, duration: track.duration || 0, buffered: 0 });
  if (autoplay) {
    void audio.play().catch(() => usePlayerStore.setState({ isPlaying: false }));
  }
}

function advance(step: number, auto: boolean): void {
  const state = usePlayerStore.getState();
  if (state.queue.length === 0) return;
  let pos = state.orderPos + step;
  if (pos >= state.order.length) {
    if (auto && state.repeat !== "all") {
      // End of queue, repeat off: rest on the last track.
      usePlayerStore.setState({ isPlaying: false, position: 0 });
      audio?.pause();
      if (audio) audio.currentTime = 0;
      return;
    }
    pos = 0;
  }
  if (pos < 0) pos = 0;
  const track = state.queue[state.order[pos]];
  usePlayerStore.setState({ orderPos: pos });
  load(track, true);
}

if (audio) {
  audio.volume = usePlayerStore.getState().volume;

  audio.addEventListener("play", () => usePlayerStore.setState({ isPlaying: true }));
  audio.addEventListener("pause", () => usePlayerStore.setState({ isPlaying: false }));
  audio.addEventListener("timeupdate", () =>
    usePlayerStore.setState({ position: audio!.currentTime }),
  );
  audio.addEventListener("durationchange", () =>
    usePlayerStore.setState({
      duration: Number.isFinite(audio!.duration) ? audio!.duration : 0,
    }),
  );
  audio.addEventListener("progress", () => {
    const b = audio!.buffered;
    usePlayerStore.setState({
      buffered: b.length > 0 ? b.end(b.length - 1) : 0,
    });
  });
  audio.addEventListener("ended", () => {
    const state = usePlayerStore.getState();
    if (state.repeat === "one") {
      audio!.currentTime = 0;
      void audio!.play();
      return;
    }
    advance(1, true);
  });
  audio.addEventListener("error", () => {
    // Missing file / network hiccup: stop cleanly rather than hang.
    usePlayerStore.setState({ isPlaying: false });
  });
}
