/* Player state + audio engine — one module, deliberately.
   The <audio> element lives outside React's lifecycle so playback continues
   across navigation (DESIGN.md §9.4). Store holds state; the thin engine
   layer below the store binds element events back into it. M5 adds queue
   removal (§9.4) and Media Session integration (§13.11). */

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
  /** Appends tracks to the END of the play order (§23 — the queue's Add
      button). Plays nothing: the queue can be built before playback starts,
      in which case `orderPos` sits at -1 until a row is clicked. */
  addToQueue: (tracks: Track[]) => void;
  /** Removes an upcoming track from the queue (§9.4). No-op for the current one. */
  removeFromQueue: (queueIndex: number) => void;
  /** Undoes a queue removal (§26): re-inserts the track at its former
      queue index and play-order slot. The playing row's pointer follows
      the world shift, as in every other queue mutation. */
  restoreToQueue: (orderSlot: number, queueIndex: number, track: Track) => void;
  /** Drag-to-reorder in the queue drawer: moves one entry of the PLAY ORDER
      (order indexes, not queue indexes — shuffle is respected). The playing
      row stays put; everything else reorders around it. */
  moveInQueue: (fromOrder: number, toOrder: number) => void;
  /** Click-to-jump (§17.7): start playback at any position in the play order. */
  playAt: (orderIndex: number) => void;
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
        const { queue, order, orderPos } = get();
        if (queue.length === 0) {
          get().playTracks([track], 0);
          return;
        }
        const currentQueueIndex = order[orderPos];
        const newQueue = [...queue];
        newQueue.splice(currentQueueIndex + 1, 0, track);
        // Insert into the existing order right after the current position:
        // the track is guaranteed to play next, and with shuffle on the rest
        // of the planned order stays put (a full rebuild would reshuffle it).
        const remapped = order.map((i) => (i > currentQueueIndex ? i + 1 : i));
        remapped.splice(orderPos + 1, 0, currentQueueIndex + 1);
        // Seamless: the audio element keeps playing; only the plan changes.
        set({ queue: newQueue, order: remapped, orderPos });
      },

      addToQueue: (tracks) => {
        if (tracks.length === 0) return;
        const { queue, order, orderPos } = get();
        const base = queue.length;
        set({
          queue: [...queue, ...tracks],
          order: [...order, ...tracks.map((_, i) => base + i)],
          // An idle-built queue plays nothing yet: orderPos -1 means "no
          // current track" (useCurrentTrack reads order[-1] → undefined).
          orderPos: queue.length === 0 ? -1 : orderPos,
        });
      },

      removeFromQueue: (queueIndex) => {
        const { order, orderPos } = get();
        const currentQueueIndex = order[orderPos];
        if (queueIndex === currentQueueIndex) return;
        const orderIdx = order.indexOf(queueIndex);
        if (orderIdx === -1) return;
        // The current track keeps playing untouched — drop it from the plan
        // only, recompacting both arrays around it. The current track's own
        // index must ride the recompact too (removing a row queued before
        // it shifts every later index down by one); recomputing with the
        // stale value would lose the pointer (orderPos -1).
        const newQueue = get().queue.filter((_, i) => i !== queueIndex);
        const newOrder = order
          .filter((i) => i !== queueIndex)
          .map((i) => (i > queueIndex ? i - 1 : i));
        const newCurrent =
          currentQueueIndex > queueIndex ? currentQueueIndex - 1 : currentQueueIndex;
        set({
          queue: newQueue,
          order: newOrder,
          orderPos: newOrder.indexOf(newCurrent),
        });
      },

      restoreToQueue: (orderSlot, queueIndex, track) => {
        const { queue, order, orderPos } = get();
        // Clamp into whatever the list looks like now — reorders or adds
        // between removal and undo may have shifted things (§26: the
        // restore is best-effort at the former slot).
        const idx = Math.max(0, Math.min(queueIndex, queue.length));
        const slot = Math.max(0, Math.min(order.length, orderSlot));
        const currentQueueIndex = order[orderPos];
        const newQueue = [...queue];
        newQueue.splice(idx, 0, track);
        // Every queue index at/after the re-insertion shifts up by one —
        // the order entries ride along, and the track takes its slot.
        const newOrder = order.map((i) => (i >= idx ? i + 1 : i));
        newOrder.splice(slot, 0, idx);
        const newCurrent =
          currentQueueIndex != null && currentQueueIndex >= idx
            ? currentQueueIndex + 1
            : currentQueueIndex;
        set({
          queue: newQueue,
          order: newOrder,
          orderPos: newOrder.indexOf(newCurrent),
        });
      },

      playAt: (orderIndex) => {
        const { order, queue } = get();
        if (orderIndex < 0 || orderIndex >= order.length) return;
        usePlayerStore.setState({ orderPos: orderIndex });
        load(queue[order[orderIndex]], true);
      },

      moveInQueue: (fromOrder, toOrder) => {
        const { order, orderPos } = get();
        if (fromOrder === toOrder) return;
        if (fromOrder < 0 || fromOrder >= order.length) return;
        if (fromOrder === orderPos) return; // the playing row is anchored
        const next = order.slice();
        const [moved] = next.splice(fromOrder, 1);
        // `toOrder` is an insertion slot in the pre-move list; after splicing
        // the source out, slots past it shift back by one.
        let to = toOrder;
        if (to > fromOrder) to -= 1;
        to = Math.max(0, Math.min(next.length, to));
        next.splice(to, 0, moved);
        // Follow the playing row as the world shifts around it.
        let pos = orderPos;
        if (fromOrder < orderPos) pos -= 1;
        if (to <= pos) pos += 1;
        set({ order: next, orderPos: pos });
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
  syncMediaSessionMetadata(track);
  if (autoplay) {
    void audio.play().catch(() => usePlayerStore.setState({ isPlaying: false }));
  }
}

/* ---- Media Session (approved nicety, §13.11) — OS media keys + lock screen */

function syncMediaSessionMetadata(track: Track): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const artwork =
    track.artwork_id != null
      ? [{ src: `/api/artwork/${track.artwork_id}`, sizes: "512x512" }]
      : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist ?? "",
    album: track.album ?? "",
    artwork,
  });
}

function setupMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !audio) return;
  navigator.mediaSession.setActionHandler("play", () => void audio!.play());
  navigator.mediaSession.setActionHandler("pause", () => audio!.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () =>
    usePlayerStore.getState().prev(),
  );
  navigator.mediaSession.setActionHandler("nexttrack", () =>
    usePlayerStore.getState().next(),
  );
}

function setPlaybackState(state: "playing" | "paused"): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = state;
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
  setupMediaSession();

  audio.addEventListener("play", () => {
    usePlayerStore.setState({ isPlaying: true });
    setPlaybackState("playing");
  });
  audio.addEventListener("pause", () => {
    usePlayerStore.setState({ isPlaying: false });
    setPlaybackState("paused");
  });
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
