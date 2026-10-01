/* Player state + audio engine — one module, deliberately.
   The <audio> element lives outside React's lifecycle so playback continues
   across navigation (DESIGN.md §9.4). Store holds state; the thin engine
   layer below the store binds element events back into it. M5 adds queue
   removal (§9.4) and Media Session integration (§13.11).

   §29: the queue is durable session state. Queue + play order + playhead
   position persist to localStorage and restore silently on load — paused,
   player bar populated — so a reload (Cmd+R, OS update, sleep) never costs
   the listening session (§13.9's "Continue listening"). The first press of
   play resumes the saved track at the saved position; nothing autoplays. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Track } from "../api/types";
import { useUiStore } from "./ui";

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
        errorSkipStreak = 0; // a fresh queue is a fresh chance for the library
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
        errorSkipStreak = 0;
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
        if (!audio) return;
        const { queue, order, orderPos, position } = get();
        if (queue.length === 0) return;
        const track = queue[order[orderPos]];
        if (!track) return;
        // A restored session has never loaded the current track into the
        // element: the first play resumes at the saved position (§29).
        if (loadedSrc == null) {
          load(track, true, position);
          return;
        }
        if (audio.paused) {
          void audio.play().catch(() => set({ isPlaying: false }));
        } else {
          audio.pause();
        }
      },

      next: () => {
        errorSkipStreak = 0;
        advance(1, false);
      },
      prev: () => {
        errorSkipStreak = 0;
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
      // Durable preferences ride the persist middleware. The queue and the
      // playhead are durable SESSION state (§29) — persisted below by the
      // hand-rolled writer, not here: the middleware re-serializes on every
      // store update, and position changes 4×/s while playing, which would
      // stringify a full-library queue at that cadence.
      partialize: (s) => ({ volume: s.volume, shuffle: s.shuffle, repeat: s.repeat }),
    },
  ),
);

/* ---- audio engine ------------------------------------------------------- */

const audio: HTMLAudioElement | null =
  typeof window !== "undefined" ? new Audio() : null;

/** The stream URL the element currently holds — null until the first real
    load. A restored session plays from a populated store with a virgin
    element; the first play loads at the saved position (§29). */
let loadedSrc: string | null = null;

/** Consecutive auto-skips on stream errors without a successful start
    between them (§29). Bounded so a dead stretch of library can't
    machine-gun through the whole queue; any manual interaction resets it. */
let errorSkipStreak = 0;
const MAX_ERROR_SKIPS = 5;

function load(track: Track, autoplay: boolean, startAt?: number): void {
  if (!audio || !track) return;
  const src = `/api/stream/${track.id}`;
  loadedSrc = src;
  audio.src = src;
  // Setting currentTime before metadata arrives sets the default playback
  // start position — the element seeks there once it can (spec behavior).
  const at = startAt != null && startAt > 0.25 ? startAt : 0;
  if (at > 0) audio.currentTime = at;
  usePlayerStore.setState({
    position: at,
    duration: track.duration || 0,
    buffered: 0,
  });
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
    errorSkipStreak = 0; // a real start — the library is alive again
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
    // Missing file / flaky mount / half-written file — routine in a
    // self-hosted library (§29). Skip to the next track and say so, like
    // Plex; only a bounded streak later, stop rather than machine-gun.
    if (loadedSrc == null || !audio) return;
    const state = usePlayerStore.getState();
    const track = state.queue[state.order[state.orderPos]];
    // A stale event for an already-replaced source must not skip twice.
    // (audio.currentSrc is absolute and unsettled during failed loads —
    // the engine's own record of the requested URL is the truth.)
    if (track == null || loadedSrc !== `/api/stream/${track.id}`) return;
    errorSkipStreak += 1;
    if (errorSkipStreak > MAX_ERROR_SKIPS) {
      usePlayerStore.setState({ isPlaying: false });
      useUiStore.getState().showUndoNotice({
        message: "Playback stopped — several files were unavailable.",
      });
      return;
    }
    useUiStore.getState().showUndoNotice({
      message: `Skipped “${track.title}” — file unavailable.`,
    });
    advance(1, true); // rest at the end of the queue, like a natural finish
  });
}

/* ---- session persistence (§13.9, §29) -----------------------------------
   The queue survives a reload: two keys, written at different cadences.
   `flow.player.queue` (queue + order) only changes when the plan changes —
   small debounced writes. `flow.player.playhead` (orderPos + position +
   timestamp) moves constantly while playing — throttled to one tiny write
   every few seconds, plus a flush when the page hides. Everything is best-
   effort: a quota failure or a corrupt snapshot costs nothing but the
   convenience the feature exists for. */

const QUEUE_KEY = "flow.player.queue";
const PLAYHEAD_KEY = "flow.player.playhead";
const QUEUE_SAVE_DEBOUNCE_MS = 400;
const PLAYHEAD_SAVE_INTERVAL_MS = 3000;

let queueSaveTimer: number | null = null;
let playheadSaveTimer: number | null = null;
let playheadDirty = false;

function writeQueueSnapshot(): void {
  const { queue, order } = usePlayerStore.getState();
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ queue, order }));
  } catch {
    // Over quota (a very large library): this session still plays; the
    // next one just starts empty. Preferences live in the other key.
  }
}

function writePlayhead(): void {
  const { orderPos, position } = usePlayerStore.getState();
  try {
    localStorage.setItem(
      PLAYHEAD_KEY,
      JSON.stringify({ orderPos, position, savedAt: Date.now() }),
    );
  } catch {
    // Same best-effort story as the queue snapshot.
  }
}

function schedulePlayheadSave(delayMs: number): void {
  playheadDirty = true;
  if (playheadSaveTimer != null) return;
  playheadSaveTimer = window.setTimeout(() => {
    playheadSaveTimer = null;
    if (!playheadDirty) return;
    playheadDirty = false;
    writePlayhead();
  }, delayMs);
}

if (typeof window !== "undefined") {
  usePlayerStore.subscribe((state, prev) => {
    if (state.queue !== prev.queue || state.order !== prev.order) {
      if (queueSaveTimer == null) {
        queueSaveTimer = window.setTimeout(() => {
          queueSaveTimer = null;
          writeQueueSnapshot();
        }, QUEUE_SAVE_DEBOUNCE_MS);
      }
      schedulePlayheadSave(QUEUE_SAVE_DEBOUNCE_MS);
    } else if (state.orderPos !== prev.orderPos) {
      schedulePlayheadSave(QUEUE_SAVE_DEBOUNCE_MS);
    } else if (state.position !== prev.position) {
      schedulePlayheadSave(PLAYHEAD_SAVE_INTERVAL_MS);
    }
  });

  const flushSession = () => {
    if (queueSaveTimer != null) {
      window.clearTimeout(queueSaveTimer);
      queueSaveTimer = null;
      writeQueueSnapshot();
    }
    if (playheadSaveTimer != null) {
      window.clearTimeout(playheadSaveTimer);
      playheadSaveTimer = null;
    }
    playheadDirty = false;
    writePlayhead();
  };
  // Sleep, tab close, refresh, navigation: the playhead must be current.
  window.addEventListener("pagehide", flushSession);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSession();
  });
}

function restoreSession(): void {
  if (typeof localStorage === "undefined") return;
  let queue: Track[] = [];
  let order: number[] = [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { queue?: unknown; order?: unknown };
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.order)) return;
    queue = parsed.queue as Track[];
    order = parsed.order as number[];
  } catch {
    return; // corrupt snapshot: start clean
  }
  if (
    queue.length === 0 ||
    queue.some((t) => t == null || typeof t.id !== "number" || typeof t.title !== "string")
  )
    return;
  if (order.length !== queue.length || order.some((i) => !Number.isInteger(i) || i < 0 || i >= queue.length)) {
    order = queue.map((_, i) => i);
  }
  let orderPos = 0;
  let position = 0;
  try {
    const raw = localStorage.getItem(PLAYHEAD_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { orderPos?: unknown; position?: unknown };
      if (typeof p.orderPos === "number" && Number.isInteger(p.orderPos)) {
        orderPos = Math.min(Math.max(p.orderPos, 0), order.length - 1);
      }
      if (typeof p.position === "number" && Number.isFinite(p.position)) {
        position = Math.max(0, p.position);
      }
    }
  } catch {
    // defaults
  }
  const track = queue[order[orderPos]];
  if (!track) return;
  usePlayerStore.setState({
    queue,
    order,
    orderPos,
    // Restored sessions are always paused — autoplay policies aside, the
    // review's bar is that state loss is never TOTAL, never that sound
    // starts uninvited (§29). The element stays empty until the first play.
    isPlaying: false,
    position: Math.min(position, track.duration || position),
    duration: track.duration || 0,
  });
}

restoreSession();
