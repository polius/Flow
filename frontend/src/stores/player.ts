/* Player state + audio engine — one module, deliberately. The <audio>
   elements live outside React's lifecycle so playback continues across
   navigation; the store holds state and a thin engine layer binds element
   events back into it. Restored sessions always come back paused — a
   reload never costs the listening session, and nothing autoplays. */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { AUTH_STATUS_KEY } from "../api/auth";
import { api } from "../api/client";
import { queryClient } from "../api/queryClient";
import {
  fetchServerQueue,
  saveServerPlayhead,
  saveServerQueue,
  type ServerQueueState,
} from "../api/queue";
import type { QueueOrigin, Track } from "../api/types";
import { isIOS } from "../lib/platform";
import { useUiStore } from "./ui";

export type RepeatMode = "off" | "all" | "one";

/** The sleep timer: a wall-clock deadline, or "stop when this track
    ends". Session-only — a reload never inherits a timer. */
export type SleepTimer =
  | { kind: "minutes"; minutes: number; endsAt: number }
  | { kind: "track" };

/** A hand-built queue has no origin to name: nothing renders in the
    "Playing from" surfaces. */
const MANUAL_ORIGIN: QueueOrigin = { kind: "manual", label: null, href: null };

/** Queue additions confirm their arrival: quiet, one line, honest about
    where the tracks landed — and undoable, since the exact instances
    inserted are the exact instances removed. The exception is "now":
    tracks that STARTED playing can't be un-added without stopping the
    music, so that gain stays quiet. */
function confirmArrival(
  n: number,
  destination: "next" | "end" | "now",
  tracks: Track[],
): void {
  const noun = n === 1 ? "song" : "songs";
  const where =
    destination === "next"
      ? "play next"
      : destination === "now"
        ? "now playing"
        : "end of queue";
  const message = `Added ${n} ${noun} — ${where}`;
  if (destination === "now") {
    useUiStore.getState().showUndoNotice({ message });
    return;
  }
  useUiStore.getState().showUndoNotice({
    message,
    undo: async () => usePlayerStore.getState().removeQueued(tracks),
  });
}

interface PlayerState {
  queue: Track[];
  order: number[]; // positions into queue (identity, or shuffled)
  orderPos: number; // index into order
  isPlaying: boolean;
  position: number; // seconds
  duration: number; // seconds (from the audio element once known)
  buffered: number; // seconds buffered ahead
  shuffle: boolean;
  repeat: RepeatMode;
  /** Sound Check: apply the scan's loudness analysis so albums play at a
      matched level. On by default — consistency is the behavior, the toggle
      is the escape hatch. Off → unity gain, exactly as before. */
  soundcheck: boolean;
  /** Where the queue came from: the "Playing from" sentence on the queue
      drawer and Now Playing. Set only by queue REPLACEMENT (play tracks /
      adopt a snapshot), read-only for every queue edit — appending to an
      album queue doesn't rewrite where it came from. */
  origin: QueueOrigin | null;
  /** Output level, 0..1 (desktop only — iOS volume is hardware-only, and
      the control hides itself there). Rides the Sound Check gain stage
      when the Web Audio graph exists, the element's own volume when not. */
  volume: number;
  muted: boolean;
  sleep: SleepTimer | null;

  playTracks: (tracks: Track[], startIndex: number, origin?: QueueOrigin | null) => void;
  /** Adopts a server-built queue: the POST /api/queue snapshot, with the
      play order and playhead already resolved whole-filter server-side.
      The store takes it wholesale and plays it; `origin` rides the
      snapshot. */
  playSnapshot: (snapshot: {
    items: Track[];
    order: number[];
    order_pos: number;
    origin?: QueueOrigin | null;
  }) => void;
  playNext: (track: Track) => void;
  /** Play Next for a whole collection (header menus): the tracks insert,
      in order, directly after the playing one. */
  playNextMany: (tracks: Track[]) => void;
  /** Appends tracks to the END of the play order (the queue's Add button,
      and "Add to Queue (end)"). Plays nothing: the queue can be built
      before playback starts, in which case `orderPos` sits at -1 until a
      row is clicked. On an empty queue the session's origin becomes
      `manual` — a hand-built queue came from nowhere else. */
  addToQueue: (tracks: Track[]) => void;
  /** Removes exactly the given track instances from the queue — the undo
      for "Play Next" / "Add to Queue". Matches by REFERENCE, so a
      duplicated id elsewhere in the queue keeps its place; the playing
      row's pointer follows the recompact like every other mutation. */
  removeQueued: (tracks: Track[]) => void;
  /** Removes an upcoming track from the queue. No-op for the current one. */
  removeFromQueue: (queueIndex: number) => void;
  /** Empties the queue in one gesture (the drawer's Clear button): playback
      stops, everything is dropped, and the whole session is offered back
      through the undo toast. */
  clearQueue: () => void;
  /** Undoes a queue removal: re-inserts the track at its former queue
      index and play-order slot. The playing row's pointer follows the
      world shift, as in every other queue mutation. */
  restoreToQueue: (orderSlot: number, queueIndex: number, track: Track) => void;
  /** Drag-to-reorder in the queue drawer: moves one entry of the PLAY ORDER
      (order indexes, not queue indexes — shuffle is respected). The playing
      row stays put; everything else reorders around it. */
  moveInQueue: (fromOrder: number, toOrder: number) => void;
  /** Click-to-jump: start playback at any position in the play order. */
  playAt: (orderIndex: number) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setShuffle: (on: boolean) => void;
  cycleRepeat: () => void;
  setSoundcheck: (on: boolean) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  /** Minutes from now, "track" (stop when the current track ends), or
      null to cancel. */
  setSleepTimer: (choice: number | "track" | null) => void;
}

export function useCurrentTrack(): Track | null {
  return usePlayerStore((s) => s.queue[s.order[s.orderPos]] ?? null);
}

/** The play order for `count` tracks starting at queue index
    `startIndex`: identity, or a shuffle with the start track at its head.
    A negative start is an idle queue (built, nothing loaded): the order
    is rebuilt around no anchor and the playhead stays at -1. */
export function buildOrder(
  count: number,
  shuffle: boolean,
  startIndex: number,
): { order: number[]; pos: number } {
  if (count === 0) return { order: [], pos: 0 };
  const idle = startIndex < 0;
  if (!shuffle) {
    return { order: Array.from({ length: count }, (_, i) => i), pos: idle ? -1 : startIndex };
  }
  const rest = Array.from({ length: count }, (_, i) => i).filter(
    (i) => i !== startIndex,
  );
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return idle ? { order: rest, pos: -1 } : { order: [startIndex, ...rest], pos: 0 };
}

/** The `moveInQueue` slot that nudges the row at `from` one place up or
    down (Option+↑/↓). Slots count in the PRE-move list, so one row down
    is two slots on: the row lands after its old neighbor. */
export function nudgeSlot(from: number, direction: -1 | 1): number {
  return direction < 0 ? from - 1 : from + 2;
}

/** Same queue ids in the same places — a row patched in place (a heart
    toggled) is not a plan change. */
export function sameIds(a: Track[], b: Track[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

/* ---- play requests --------------------------------------------------------
   A "play this view" that has to ask the server first (a whole filter, a
   shuffle) lands after an await — by then the user may have started
   something else. Every queue replacement bumps the epoch; an async play
   claims one up front and only lands while it is still the newest. */

let playEpoch = 0;

/** Claims the next queue replacement for an async play. Call it
    synchronously inside the click: it also unlocks audio while the user
    gesture is still live (iOS refuses a first play() that runs after an
    await). Returns the staleness check to run before playing. */
export function beginPlayRequest(): () => boolean {
  const mine = ++playEpoch;
  unlockAudio();
  return () => mine === playEpoch;
}

/* ---- volume persistence -------------------------------------------------- */

const VOLUME_KEY = "flow.player.volume";

function readVolume(): { volume: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { volume?: unknown; muted?: unknown };
      return {
        volume:
          typeof v.volume === "number" && Number.isFinite(v.volume)
            ? Math.min(1, Math.max(0, v.volume))
            : 1,
        muted: v.muted === true,
      };
    }
  } catch {
    // Unreadable or blocked storage: full volume, like a first visit.
  }
  return { volume: 1, muted: false };
}

function writeVolume(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
  } catch {
    // Best-effort: the level still applies for this session.
  }
}

let sleepTimerHandle: number | null = null;

function clearSleepHandle(): void {
  if (sleepTimerHandle != null) {
    window.clearTimeout(sleepTimerHandle);
    sleepTimerHandle = null;
  }
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
      shuffle: false,
      repeat: "off",
      soundcheck: true,
      origin: null,
      ...readVolume(),
      sleep: null,

      playTracks: (tracks, startIndex, origin) => {
        if (tracks.length === 0) return;
        playEpoch++; // any pending async play is now stale
        errorSkipStreak = 0; // a fresh queue is a fresh chance for the library
        ensureGraph(); // first user gesture: the only legal moment to start audio
        resumeGraph();
        const clamped = Math.min(Math.max(startIndex, 0), tracks.length - 1);
        const { order, pos } = buildOrder(tracks.length, get().shuffle, clamped);
        // A queue replacement is a new context: the origin is REPLACED with
        // whatever the caller declared — or `manual` when it didn't say
        // (a single-track play has no better name, and names nothing).
        set({
          queue: tracks,
          order,
          orderPos: pos,
          origin: origin ?? MANUAL_ORIGIN,
        });
        load(tracks[order[pos]], true);
      },

      playSnapshot: ({ items, order, order_pos, origin }) => {
        if (items.length === 0) return;
        playEpoch++;
        errorSkipStreak = 0;
        ensureGraph();
        resumeGraph();
        const pos = Math.min(Math.max(order_pos, 0), items.length - 1);
        set({ queue: items, order, orderPos: pos, origin: origin ?? null });
        load(items[order[pos]], true);
      },

      playNext: (track) => get().playNextMany([track]),

      playNextMany: (tracks) => {
        if (tracks.length === 0) return;
        const { queue, order, orderPos } = get();
        if (queue.length === 0) {
          get().playTracks(tracks, 0);
          // It didn't land next — it started.
          confirmArrival(tracks.length, "now", tracks);
          return;
        }
        const n = tracks.length;
        const currentQueueIndex = order[orderPos] as number | undefined;
        // An idle queue (built, nothing loaded: orderPos -1) has no
        // current row to follow — "next" is the head of the plan. Reading
        // order[-1] + 1 here once wrote NaN into the order.
        const idle = currentQueueIndex == null;
        const insertAt = idle ? 0 : currentQueueIndex + 1;
        const newQueue = [...queue];
        newQueue.splice(insertAt, 0, ...tracks);
        // Queue indexes at/after the insertion point ride up by n, and the
        // tracks take the play-order slots directly after the current one
        // (or the head): guaranteed to play in order, and with shuffle on
        // the rest of the planned order stays put (a full rebuild would
        // reshuffle it). Seamless: the audio element keeps playing.
        const remapped = order.map((i) => (i >= insertAt ? i + n : i));
        const slots = tracks.map((_, k) => insertAt + k);
        remapped.splice(idle ? 0 : orderPos + 1, 0, ...slots);
        set({ queue: newQueue, order: remapped, orderPos });
        // An addition confirms its arrival — one quiet line, undoable.
        confirmArrival(n, "next", tracks);
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
          // Building a queue by hand on an empty session is the one queue
          // EDIT that names an origin: manual.
          ...(queue.length === 0 ? { origin: MANUAL_ORIGIN } : {}),
        });
        confirmArrival(tracks.length, "end", tracks);
      },

      removeQueued: (tracks) => {
        if (tracks.length === 0) return;
        const { queue, order, orderPos } = get();
        const dropped = new Set(tracks); // reference identity: duplicates by id elsewhere stay
        const currentQueueIndex = order[orderPos];
        // The playing row's own slot is never dropped — even when the same
        // object was ALSO just inserted (Play Next on the playing track),
        // the plan must keep pointing at what the element is playing.
        const kept = queue.filter(
          (t, i) => i === currentQueueIndex || !dropped.has(t),
        );
        if (kept.length === queue.length) return; // nothing matched — nothing to undo
        const remap = new Map<number, number>();
        queue.forEach((t, i) => {
          if (i === currentQueueIndex || !dropped.has(t)) remap.set(i, remap.size);
        });
        const newOrder = order
          .filter((i) => i === currentQueueIndex || !dropped.has(queue[i]))
          .map((i) => remap.get(i)!);
        const newCurrent = remap.get(currentQueueIndex);
        set({
          queue: kept,
          order: newOrder,
          // The playing row's pointer follows the recompact —
          // or the queue is idle again.
          orderPos: newCurrent != null ? newOrder.indexOf(newCurrent) : -1,
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

      clearQueue: () => {
        const { queue, order, orderPos, position, origin } = get();
        if (queue.length === 0) return;
        // The exact session, captured for the undo: restoring brings the
        // playhead AND the origin back — everything but the sound. A plain
        // set re-mirrors the snapshot to the server like any queue edit.
        const snapshot = { queue, order, orderPos, position, origin };
        playEpoch++;
        intendPlay = false;
        clearStallWatch();
        clearNetworkHold();
        if (audio) {
          audio.pause();
          // The standby is stale with the plan it preloaded.
          if (standbyTrack != null) resetStandby();
        }
        const noun = queue.length === 1 ? "song" : "songs";
        set({
          queue: [],
          order: [],
          orderPos: -1,
          origin: null,
          isPlaying: false,
          position: 0,
          duration: 0,
          buffered: 0,
        });
        useUiStore.getState().showUndoNotice({
          message: `Cleared the queue — ${queue.length} ${noun}`,
          undo: async () => {
            usePlayerStore.setState(snapshot);
          },
        });
      },

      restoreToQueue: (orderSlot, queueIndex, track) => {
        const { queue, order, orderPos } = get();
        // Clamp into whatever the list looks like now — reorders or adds
        // between removal and undo may have shifted things; the restore
        // is best-effort at the former slot.
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
        playEpoch++;
        errorSkipStreak = 0;
        ensureGraph();
        resumeGraph();
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
        // element: the first play resumes at the saved position. So does
        // an element a failed stream left in its error state, or one
        // waiting on the network — play means "try again now".
        if (loadedSrc == null || audio.error != null || networkHold != null) {
          ensureGraph();
          resumeGraph();
          load(track, true, position);
          return;
        }
        if (audio.paused) {
          ensureGraph();
          resumeGraph();
          intendPlay = true;
          void audio.play().catch(() => set({ isPlaying: false }));
        } else {
          intendPlay = false;
          audio.pause();
        }
      },

      next: () => {
        errorSkipStreak = 0;
        // The preloaded next track is ready to go: start it rather than
        // throwing the buffer away and fetching it again.
        if (!swapToStandby()) advance(1, false);
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
        syncPositionState();
      },

      setSoundcheck: (on) => {
        set({ soundcheck: on });
        // The gain must follow the toggle immediately, not on next load.
        applyLevels();
      },

      setShuffle: (on) => {
        const { queue, order, orderPos } = get();
        // An idle queue keeps playing nothing: the rebuilt plan has no
        // anchor, and the playhead stays at -1.
        const currentQueueIndex = order[orderPos] ?? -1;
        const rebuilt = buildOrder(queue.length, on, currentQueueIndex);
        set({ shuffle: on, order: rebuilt.order, orderPos: rebuilt.pos });
      },

      setVolume: (volume) => {
        const v = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
        // Dragging the level up from silence is an unmute.
        set({ volume: v, muted: v === 0 ? get().muted : false });
        writeVolume(v, get().muted);
        applyLevels();
      },

      toggleMute: () => {
        set({ muted: !get().muted });
        writeVolume(get().volume, get().muted);
        applyLevels();
      },

      setSleepTimer: (choice) => {
        clearSleepHandle();
        if (choice == null) {
          set({ sleep: null });
          return;
        }
        if (choice === "track") {
          set({ sleep: { kind: "track" } });
          return;
        }
        const ms = choice * 60_000;
        set({ sleep: { kind: "minutes", minutes: choice, endsAt: Date.now() + ms } });
        sleepTimerHandle = window.setTimeout(() => {
          sleepTimerHandle = null;
          set({ sleep: null });
          intendPlay = false;
          clearNetworkHold(); // asleep means asleep: no reconnect resumes it
          audio?.pause();
        }, ms);
      },

      cycleRepeat: () => {
        const modes: RepeatMode[] = ["off", "all", "one"];
        const next = modes[(modes.indexOf(get().repeat) + 1) % modes.length];
        set({ repeat: next });
      },
    }),
    {
      name: "flow.player",
      // The middleware writes on EVERY store update: a throwing storage
      // (quota, a blocked or private-mode store) must cost the
      // preferences, never the action that triggered the write.
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return localStorage.getItem(key);
          } catch {
            return null;
          }
        },
        setItem: (key, value) => {
          try {
            localStorage.setItem(key, value);
          } catch {
            // best-effort, like every write in this module
          }
        },
        removeItem: (key) => {
          try {
            localStorage.removeItem(key);
          } catch {
            // best-effort
          }
        },
      })),
      // Preferences ride the persist middleware. The queue and the
      // playhead are durable SESSION state — persisted below by the
      // hand-rolled writer, not here: the middleware re-serializes on
      // every store update, and position changes 4×/s while playing,
      // which would stringify a full-library queue at that cadence.
      // Volume has its own key (flow.player.volume), read before the first
      // paint so the slider never jumps.
      partialize: (s) => ({
        shuffle: s.shuffle,
        repeat: s.repeat,
        soundcheck: s.soundcheck,
      }),
    },
  ),
);

/* ---- audio engine ------------------------------------------------------- */

const audioA: HTMLAudioElement | null =
  typeof window !== "undefined" ? new Audio() : null;
const audioB: HTMLAudioElement | null =
  typeof window !== "undefined" ? new Audio() : null;

function elements(): HTMLAudioElement[] {
  return [audioA, audioB].filter((el): el is HTMLAudioElement => el != null);
}

/** The element playing right now. Gapless swaps this binding instead of
    replacing `src` on a playing element — the switch happens at the ended
    boundary, so the old element never re-buffers. */
let audio: HTMLAudioElement | null = audioA;

/** The standby element and what it holds: the next track, preloaded and
    gain-matched, ready to start the instant the playing one ends. */
let standby: HTMLAudioElement | null = audioB;
let standbyTrack: Track | null = null;

/** The stream URL the active element currently holds — null until the first
    real load. A restored session plays from a populated store with a virgin
    element; the first play loads at the saved position. */
let loadedSrc: string | null = null;

/** Consecutive auto-skips on stream errors without a successful start
    between them. Bounded so a dead stretch of library can't
    machine-gun through the whole queue; any manual interaction resets it. */
let errorSkipStreak = 0;
const MAX_ERROR_SKIPS = 5;

/** MediaError.code → human reason (HTML spec codes; not all browsers
    expose the MediaError constructor, hence literal numbers). */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "interrupted", // MEDIA_ERR_ABORTED — fetch aborted (tab backgrounded, src swap)
  2: "network error", // MEDIA_ERR_NETWORK — connection failed mid-fetch
  3: "decoding failed", // MEDIA_ERR_DECODE — bytes arrived, browser can't decode
  4: "unreadable or missing", // MEDIA_ERR_SRC_NOT_SUPPORTED — bad status/format
};

/** How close to the end (seconds) the next track starts preloading. */
const PRELOAD_AHEAD_SECONDS = 10;

const trackSrc = (track: Track): string => `/api/stream/${track.id}`;

/* Volume: the user's level is one more factor on the Sound Check gain
   node when the Web Audio graph exists — the element itself stays at
   unity there, so the two never multiply twice (browsers disagree on
   whether element volume reaches a MediaElementSource). Without a graph
   (before the first play, or where one can't start) the element's own
   volume carries the level. iOS ignores element volume outright and the
   graph is off there (below): loudness is hardware-only, and the slider
   hides itself. */

function outputLevel(): number {
  if (isIOS) return 1;
  const { volume, muted } = usePlayerStore.getState();
  // Squared: a linear slider tracks perceived loudness far better than raw
  // amplitude — the bottom half of the travel isn't all near-silence.
  return muted ? 0 : volume * volume;
}

/** Re-apply gain (Sound Check × volume) to both elements. */
function applyLevels(): void {
  applyGain(audio, currentTrack());
  if (standbyTrack) applyGain(standby, standbyTrack);
}

function currentTrack(): Track | null {
  const { queue, order, orderPos } = usePlayerStore.getState();
  return queue[order[orderPos]] ?? null;
}

/** The track that would play next — without mutating anything. */
function peekNext(): { pos: number; track: Track } | null {
  const state = usePlayerStore.getState();
  if (state.queue.length === 0) return null;
  let pos = state.orderPos + 1;
  if (pos >= state.order.length) {
    if (state.repeat !== "all") return null;
    pos = 0;
  }
  return { pos, track: state.queue[state.order[pos]] };
}

/* -- Sound Check: one Web Audio graph, two gain nodes --------------------- */
/* Created lazily inside the first user-gesture play (autoplay policies);
   a context that can't start just leaves unity gain — the feature
   degrades, playback doesn't. */

let audioCtx: AudioContext | null = null;
const gainNodes = new Map<HTMLAudioElement, GainNode>();

function ensureGraph(): void {
  // iOS: the OS suspends AudioContext rendering the moment the page is
  // backgrounded, and an element routed through the graph falls silent
  // with it. The elements play straight to the output there — the one
  // path Apple keeps alive with the screen off (Sound Check degrades;
  // its setting hides itself on iOS).
  if (isIOS) return;
  if (audioCtx != null || typeof window === "undefined") return;
  try {
    const Ctx: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    for (const el of elements()) {
      const src = audioCtx.createMediaElementSource(el);
      const gain = audioCtx.createGain();
      src.connect(gain);
      gain.connect(audioCtx.destination);
      gainNodes.set(el, gain);
    }
    // The first write matches the current toggle and level, not the
    // node's unity default — and moves the level off the elements.
    applyLevels();
  } catch {
    // No graph (old browser, blocked context): play plain, stay honest.
    audioCtx = null;
    gainNodes.clear();
  }
}

function resumeGraph(): void {
  if (audioCtx?.state === "suspended") {
    void audioCtx.resume().catch(() => {});
  }
}

/* Coming back to the foreground after an interruption: Safari may keep
   the context suspended ("interrupted" on iOS builds, "suspended" on the
   desktop) even though the element believes it is playing — silence over
   a running song. A suspend/resume pair clears the stuck state; resume()
   alone covers the plain case. */
function recoverGraph(): void {
  if (audioCtx == null || audioCtx.state === "running") return;
  audioCtx
    .suspend()
    .then(() => audioCtx?.resume())
    .catch(() => {});
}

function applyGain(el: HTMLAudioElement | null, track: Track | null): void {
  if (el == null) return;
  const level = outputLevel();
  const gain = gainNodes.get(el);
  if (gain == null || audioCtx == null) {
    // No graph: the element carries the level (Sound Check needs the
    // graph and degrades to unity).
    if (!isIOS) el.volume = level;
    return;
  }
  if (el.volume !== 1) el.volume = 1;
  const { soundcheck } = usePlayerStore.getState();
  const db = soundcheck && track != null ? track.gain_db : null;
  // setTargetAtTime glides the step so a Sound Check toggle, a volume
  // drag, or the first apply mid-play never clicks.
  gain.gain.setTargetAtTime(
    (db != null ? Math.pow(10, db / 20) : 1) * level,
    audioCtx.currentTime,
    0.015,
  );
}

/* -- iOS audio unlock ---------------------------------------------------------
   iOS grants playback per element, and only to a play() that starts inside
   a user gesture. A play that must ask the server first (a whole filter,
   a shuffle) reaches play() after an await, outside the gesture — so the
   click itself plays a few milliseconds of silence on a virgin element;
   from then on the element is ours. Desktop browsers grant the whole page
   on the first gesture: nothing to do there but start the graph. */

let elementUnlocked = false;
let silentSrc: string | null = null;

function silentWav(): string {
  if (silentSrc != null) return silentSrc;
  const samples = 400; // 50 ms of 8-bit silence at 8 kHz
  const bytes = new Uint8Array(44 + samples).fill(128);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  silentSrc = `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
  return silentSrc;
}

function unlockAudio(): void {
  ensureGraph();
  resumeGraph();
  if (!isIOS || elementUnlocked || audio == null || loadedSrc != null) return;
  elementUnlocked = true;
  const el = audio;
  el.src = silentWav();
  // The engine ignores this element's events while loadedSrc is null —
  // the silence is machinery, never a real start.
  void el
    .play()
    .then(() => {
      if (loadedSrc == null) el.pause();
    })
    .catch(() => {
      elementUnlocked = false;
    });
}

/* -- window title + lock screen ---------------------------------------------- */

let lastTitleKey = "";
function syncWindowTitle(): void {
  if (typeof document === "undefined") return;
  const track = currentTrack();
  const key = track ? `${track.id}` : "";
  if (key === lastTitleKey) return;
  lastTitleKey = key;
  document.title = track
    ? `${[track.artist, track.title].filter(Boolean).join(" — ")} · Flow`
    : "Flow";
}

let lastMetadataKey = "";
function syncMediaSessionMetadata(track: Track | null): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const key = track ? `${track.id}:${track.artwork_id}` : "";
  if (key === lastMetadataKey) return;
  lastMetadataKey = key;
  if (track == null) {
    // Nothing queued: the lock screen must stop naming the old track.
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
    return;
  }
  const artwork =
    track.artwork_id != null
      ? [{ src: `/api/artwork/${track.artwork_id}?s=512`, sizes: "512x512" }]
      : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist ?? "",
    album: track.album ?? "",
    artwork,
  });
}

/** The tab title and the lock screen follow the current track — including
    no track at all (a cleared queue). */
function syncNowPlayingSurfaces(): void {
  syncWindowTitle();
  syncMediaSessionMetadata(currentTrack());
}

/** Whether the user means sound to be coming out: set by every play and
    pause the user (or the plan) asks for, never by a pause the engine
    makes itself — so a network hold knows whether to resume. */
let intendPlay = false;

function load(track: Track, autoplay: boolean, startAt?: number): void {
  if (!audio || !track) return;
  const src = trackSrc(track);
  loadedSrc = src;
  intendPlay = autoplay;
  // A new load supersedes any wait on the network or a stall.
  clearStallWatch();
  clearNetworkHold();
  // Any prepared standby is stale from here — the plan changed underneath.
  resetStandby();
  audio.src = src;
  applyGain(audio, track);
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
  syncWindowTitle();
  syncPositionState();
  if (autoplay) {
    void audio.play().catch(() => usePlayerStore.setState({ isPlaying: false }));
  }
}

function resetStandby(): void {
  if (standby != null) {
    standby.removeAttribute("src");
    standby.load();
  }
  standbyTrack = null;
}

/** Preload the next track into the standby element once the playing one is
    close enough to the end. No-op when already prepared, at the (no-repeat)
    end of the queue, or while the graph/element machinery is unavailable. */
function prepareStandby(): void {
  if (audio == null || standby == null) return;
  // iOS: one element only. A standby that no user gesture ever started is
  // an element iOS may refuse to play at the boundary — music stopping
  // between tracks with the screen off. The classic advance reloads the
  // element the user already unlocked.
  if (isIOS) return;
  if (usePlayerStore.getState().repeat === "one") {
    // Repeat-one never advances: nothing to pre-roll.
    if (standbyTrack != null) resetStandby();
    return;
  }
  const next = peekNext();
  if (next == null) {
    if (standbyTrack != null) resetStandby();
    return;
  }
  if (standbyTrack?.id === next.track.id) return;
  standbyTrack = next.track;
  standby.src = trackSrc(next.track);
  applyGain(standby, next.track);
  standby.load();
}

/** The gapless switch: play the prepared standby at the ended boundary
    (or on Next, when it is ready). Returns false when nothing usable is
    prepared (caller falls back). */
function swapToStandby(): boolean {
  if (audio == null || standby == null || standbyTrack == null) return false;
  if (standby.readyState < 2) return false; // nothing usable buffered
  const next = peekNext();
  if (next?.track.id !== standbyTrack.id) return false;
  const finished = audio;
  const prepared = standby;
  audio = prepared;
  standby = finished;
  loadedSrc = trackSrc(next.track);
  intendPlay = true;
  standbyTrack = null;
  clearStallWatch();
  clearNetworkHold();
  resetStandby(); // the finished element becomes the next standby
  usePlayerStore.setState({
    orderPos: next.pos,
    position: 0,
    duration: next.track.duration || 0,
    buffered: 0,
  });
  errorSkipStreak = 0;
  syncMediaSessionMetadata(next.track);
  syncWindowTitle();
  syncPositionState();
  void audio.play().catch(() => usePlayerStore.setState({ isPlaying: false }));
  return true;
}

/* ---- Media Session — OS media keys + lock screen -------------------------- */

const MEDIA_SEEK_STEP = 10;

function seekBy(delta: number): void {
  const { position, duration, seek } = usePlayerStore.getState();
  const target = position + delta;
  seek(Math.max(0, duration > 0 ? Math.min(duration, target) : target));
}

function setupMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !audio) return;
  const session = navigator.mediaSession;
  const handle = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // This browser doesn't know the action: the others still work.
    }
  };
  // Play and pause go through the store's toggle: after a reload the
  // element has no source yet, and togglePlay is what loads the restored
  // track at its saved position (a bare element.play() did nothing).
  handle("play", () => {
    if (audio == null || audio.paused) usePlayerStore.getState().togglePlay();
  });
  handle("pause", () => {
    if (audio != null && !audio.paused) usePlayerStore.getState().togglePlay();
  });
  handle("stop", () => {
    intendPlay = false;
    audio?.pause();
  });
  handle("previoustrack", () => usePlayerStore.getState().prev());
  handle("nexttrack", () => usePlayerStore.getState().next());
  handle("seekto", (details) => {
    if (details.seekTime != null) seekBy(details.seekTime - usePlayerStore.getState().position);
  });
  handle("seekbackward", (details) => seekBy(-(details.seekOffset ?? MEDIA_SEEK_STEP)));
  handle("seekforward", (details) => seekBy(details.seekOffset ?? MEDIA_SEEK_STEP));
}

/** The lock-screen scrubber: duration, position and rate, refreshed on
    play, pause, seek and duration change (the OS extrapolates between). */
function syncPositionState(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  if (typeof session.setPositionState !== "function") return;
  const { position, duration } = usePlayerStore.getState();
  try {
    if (duration > 0 && Number.isFinite(duration)) {
      session.setPositionState({
        duration,
        playbackRate: audio?.playbackRate || 1,
        position: Math.min(Math.max(0, position), duration),
      });
    } else {
      session.setPositionState();
    }
  } catch {
    // An inconsistent snapshot (position past a stale duration): the next
    // event writes a good one.
  }
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
      intendPlay = false;
      usePlayerStore.setState({ isPlaying: false, position: 0 });
      audio?.pause();
      if (audio) audio.currentTime = 0;
      syncPositionState();
      return;
    }
    pos = 0;
  }
  if (pos < 0) pos = 0;
  const track = state.queue[state.order[pos]];
  usePlayerStore.setState({ orderPos: pos });
  load(track, true);
}

/** Sleep timer, "end of track": the music stops at the boundary and the
    playhead rests on the next track, paused — pressing play continues
    the queue where the timer left it. */
function stopAfterTrack(): void {
  usePlayerStore.setState({ sleep: null });
  intendPlay = false;
  const next = peekNext();
  if (next == null) {
    usePlayerStore.setState({ isPlaying: false, position: 0 });
    if (audio) audio.currentTime = 0;
    syncPositionState();
    return;
  }
  usePlayerStore.setState({ orderPos: next.pos });
  load(next.track, false);
  usePlayerStore.setState({ isPlaying: false });
}

/* -- stream failures -----------------------------------------------------------
   A missing or undecodable file skips (bounded, below). A dropped
   connection is not the file's fault: skipping would machine-gun through
   the queue on a Wi-Fi blip. Network failures — and a stream that hangs
   without ever firing `error` — hold the playhead in place and retry:
   when the browser says it's back online, or after a short backoff when
   it never noticed it was gone (a server restart). A refused stream can
   also mean the session expired: the auth check routes to sign-in
   instead of skipping. */

const STALL_TIMEOUT_MS = 20_000;
const NETWORK_RETRY_DELAYS_MS = [2000, 5000, 10_000];

let stallTimer: number | null = null;
let networkRetries = 0;
let networkRetryTimer: number | null = null;
/** Set while playback waits on the network: what was loaded, where, and
    whether sound should come back by itself. */
let networkHold: { src: string; position: number; resume: boolean } | null = null;

function clearStallWatch(): void {
  if (stallTimer != null) {
    window.clearTimeout(stallTimer);
    stallTimer = null;
  }
}

function clearNetworkHold(): void {
  networkHold = null;
  if (networkRetryTimer != null) {
    window.clearTimeout(networkRetryTimer);
    networkRetryTimer = null;
  }
}

function armStallWatch(el: HTMLAudioElement): void {
  clearStallWatch();
  stallTimer = window.setTimeout(() => {
    stallTimer = null;
    if (el !== audio || el.paused) return;
    // Buffering this long with no error event: a hung connection.
    holdForNetwork();
  }, STALL_TIMEOUT_MS);
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function holdForNetwork(): void {
  if (audio == null || loadedSrc == null || currentTrack() == null) return;
  const first = networkHold == null;
  networkHold = {
    src: loadedSrc,
    position: usePlayerStore.getState().position,
    resume: intendPlay || (networkHold?.resume ?? false),
  };
  clearStallWatch();
  audio.pause();
  usePlayerStore.setState({ isPlaying: false });
  syncPositionState();
  if (isOffline()) {
    if (first) {
      useUiStore.getState().showUndoNotice({
        message: "Connection lost — playback resumes when you’re back online.",
      });
    }
    return; // the `online` listener takes it from here
  }
  if (networkRetries < NETWORK_RETRY_DELAYS_MS.length) {
    const delay = NETWORK_RETRY_DELAYS_MS[networkRetries++];
    if (networkRetryTimer != null) window.clearTimeout(networkRetryTimer);
    networkRetryTimer = window.setTimeout(() => {
      networkRetryTimer = null;
      resumeFromHold();
    }, delay);
    return;
  }
  // Out of quiet retries: rest here, say so, and let play try again.
  networkRetries = 0;
  networkHold = null;
  useUiStore.getState().showUndoNotice({
    message: "Can’t reach Flow — press play to try again.",
  });
}

function resumeFromHold(): void {
  const hold = networkHold;
  networkHold = null;
  if (hold == null) return;
  if (hold.src !== loadedSrc) return; // the user moved on
  const track = currentTrack();
  if (track == null || trackSrc(track) !== hold.src) return;
  load(track, hold.resume, hold.position);
}

/** Asks the server whether a refused stream was a dead session. */
async function sessionVerdict(): Promise<"ok" | "signed-out" | "unreachable"> {
  try {
    const { data, response } = await api.GET("/api/auth/status");
    if (!response.ok || data == null) return response.status >= 500 ? "unreachable" : "ok";
    if (data.enabled && !data.authenticated) {
      // Flip the cached status: the shell guard routes to sign-in.
      queryClient.setQueryData(AUTH_STATUS_KEY, data);
      return "signed-out";
    }
    return "ok";
  } catch {
    return "unreachable";
  }
}

function skipFailed(track: Track, reason: string): void {
  errorSkipStreak += 1;
  if (errorSkipStreak > MAX_ERROR_SKIPS) {
    intendPlay = false;
    usePlayerStore.setState({ isPlaying: false });
    useUiStore.getState().showUndoNotice({
      message: "Playback stopped — several files were unavailable.",
    });
    return;
  }
  useUiStore.getState().showUndoNotice({
    message: `Skipped “${track.title}” — file unavailable (${reason}).`,
  });
  advance(1, true); // rest at the end of the queue, like a natural finish
}

/* ---- tabs -------------------------------------------------------------------
   One browser, one voice: a tab that starts playing tells the others,
   and they pause. A tab that yielded also stops mirroring its (now stale)
   playhead to the server until the user acts in it again. Optional —
   jsdom and old Safari have no BroadcastChannel. */

const TAB_ID = Math.random().toString(36).slice(2);
let tabChannel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    tabChannel = new BroadcastChannel("flow.player");
    // Node's channel (tests) would otherwise hold the process open.
    (tabChannel as BroadcastChannel & { unref?: () => void }).unref?.();
  }
} catch {
  tabChannel = null;
}

/** Another tab took over playback: this one stops writing its playhead. */
let yieldedToOtherTab = false;

tabChannel?.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type?: unknown; tab?: unknown } | null;
  if (msg?.type !== "playing" || msg.tab === TAB_ID) return;
  yieldedToOtherTab = true;
  intendPlay = false;
  clearNetworkHold();
  if (audio != null && !audio.paused) audio.pause();
});

for (const el of elements()) {
  // Every handler guards on `el !== audio`: the standby element's events
  // are machinery, never state. The one exception is its load error —
  // a failed preload must fall back to the classic advance path. Events
  // before the first real load (the iOS unlock's silence) are machinery
  // too.
  const live = () => el === audio && loadedSrc != null;
  el.addEventListener("play", () => {
    if (!live()) return;
    elementUnlocked = true; // a real start: iOS has granted this element
    resumeGraph();
    usePlayerStore.setState({ isPlaying: true });
    errorSkipStreak = 0; // a real start — the library is alive again
    setPlaybackState("playing");
    syncPositionState();
    yieldedToOtherTab = false;
    tabChannel?.postMessage({ type: "playing", tab: TAB_ID });
    // A real start is what played_at means: sync the playhead now,
    // not on the 3 s cadence, carrying the track id so the server stamps
    // the right row even while the plan mirror is still in flight.
    writePlayhead(true);
  });
  el.addEventListener("playing", () => {
    if (!live()) return;
    clearStallWatch();
    networkRetries = 0; // bytes are flowing again
  });
  el.addEventListener("waiting", () => {
    if (!live() || el.paused) return;
    armStallWatch(el);
  });
  el.addEventListener("pause", () => {
    if (!live()) return;
    clearStallWatch();
    usePlayerStore.setState({ isPlaying: false });
    setPlaybackState("paused");
    syncPositionState();
  });
  /* `timeupdate` (~4 Hz) is the position clock. A per-frame loop once
     glided the scrubber at 60 updates a second — a re-render per frame
     for a fill that moves a fraction of a pixel; 4 Hz is indistinguishable
     and keeps phones cool. */
  el.addEventListener("timeupdate", () => {
    if (!live()) return;
    usePlayerStore.setState({ position: el.currentTime });
    if (
      Number.isFinite(el.duration) &&
      el.duration - el.currentTime <= PRELOAD_AHEAD_SECONDS
    ) {
      prepareStandby();
    }
  });
  el.addEventListener("durationchange", () => {
    if (!live()) return;
    usePlayerStore.setState({
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
    syncPositionState();
  });
  el.addEventListener("progress", () => {
    if (!live()) return;
    const b = el.buffered;
    usePlayerStore.setState({
      buffered: b.length > 0 ? b.end(b.length - 1) : 0,
    });
  });
  el.addEventListener("ended", () => {
    if (!live()) return;
    clearStallWatch();
    const state = usePlayerStore.getState();
    if (state.sleep?.kind === "track") {
      stopAfterTrack();
      return;
    }
    if (state.repeat === "one") {
      el.currentTime = 0;
      void el.play();
      return;
    }
    // The pre-rolled next track starts at the boundary — no src swap on a
    // dying element, no 100–200ms re-buffer gap. Anything not ready
    // falls back to the classic advance, which still never skips a beat.
    if (!swapToStandby()) advance(1, true);
  });
  el.addEventListener("error", () => {
    // Missing file / flaky mount / half-written file — routine in a
    // self-hosted library. Skip to the next track and say so, like
    // Plex; only a bounded streak later, stop rather than machine-gun.
    if (el !== audio) {
      // The standby failed to load: drop it so `ended` uses the fallback.
      if (el === standby) {
        standbyTrack = null;
        el.removeAttribute("src");
      }
      return;
    }
    if (loadedSrc == null) return;
    clearStallWatch();
    const state = usePlayerStore.getState();
    const track = state.queue[state.order[state.orderPos]];
    // A stale event for an already-replaced source must not skip twice.
    // (audio.currentSrc is absolute and unsettled during failed loads —
    // the engine's own record of the requested URL is the truth.)
    if (track == null || loadedSrc !== trackSrc(track)) return;
    // The MediaError code is the only record of WHY the stream failed —
    // server logs stay clean for client-side failures (a fetch that never
    // completes, a decode error on a 200). Name the reason in the skip
    // notice so the next report diagnoses itself.
    const err = el.error;
    const reason = err
      ? MEDIA_ERROR_NAMES[err.code] ?? `error code ${err.code}`
      : "unknown error";
    console.warn(
      `Stream failed for "${track.title}" (${reason}):`,
      err?.message || "(no message)",
      loadedSrc,
    );
    // The connection, not the file: hold in place and retry.
    if (err?.code === 1 || err?.code === 2 || isOffline()) {
      holdForNetwork();
      return;
    }
    // A refused stream (4xx) reads exactly like a missing file to the
    // element. Ask before skipping: an expired session goes to sign-in,
    // an unreachable server waits like any network failure.
    const failedSrc = loadedSrc;
    void sessionVerdict().then((verdict) => {
      if (loadedSrc !== failedSrc) return; // the user moved on meanwhile
      if (verdict === "signed-out") {
        intendPlay = false;
        usePlayerStore.setState({ isPlaying: false });
        return;
      }
      if (verdict === "unreachable") {
        holdForNetwork();
        return;
      }
      skipFailed(track, reason);
    });
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (networkHold != null) {
      networkRetries = 0;
      resumeFromHold();
    }
  });
}

/* The audio session hint (recent WebKit): "playback" marks this page as
   long-form media — the signal iOS uses to keep audio alive in the
   background and wire up lock-screen controls. */
const nav = typeof navigator !== "undefined"
  ? (navigator as Navigator & { audioSession?: { type: string } })
  : null;
if (nav?.audioSession) nav.audioSession.type = "playback";

setupMediaSession();
syncWindowTitle();

/* ---- session persistence --------------------------------------------------
   The queue survives a reload — and the browser, too. Two layers, written
   at the same cadences: localStorage (the offline fallback — two keys, a
   debounced queue snapshot and a playhead throttled to one write per 3 s
   while playing) and the server (the same two writes mirrored to
   PUT /api/queue and PATCH /api/queue, so a reload on another LAN browser
   continues the same session). Fire-and-forget: a LAN blip costs the
   mirror nothing, and the local layer still holds the session. Every
   write is best-effort by contract — a failure costs nothing but the
   convenience the layer exists for.

   The local snapshot is compact: ids plus the few fields a paused,
   unverified row renders with. Whole track objects for a whole-library
   shuffle outgrew the localStorage quota — and a failed queue write under
   a successful playhead write once resumed a stale queue at a fresh
   position, so a failed queue write now clears both keys. */

const QUEUE_KEY = "flow.player.queue";
const PLAYHEAD_KEY = "flow.player.playhead";
const QUEUE_SAVE_DEBOUNCE_MS = 400;
const PLAYHEAD_SAVE_INTERVAL_MS = 3000;
/** The compact snapshot's shape version. v1.5.0 stored
    `{ queue: Track[], order, origin }` — still read, and rewritten compact,
    on the first load after the upgrade. Its readers ignore this shape
    (no `queue` key), so a rollback starts clean instead of crashing. */
const LOCAL_QUEUE_VERSION = 2;

/** One queued row as stored locally:
    [id, title, artist, album, duration, artwork_id, artist_id, album_id, gain_db]. */
type CompactRow = [
  number,
  string,
  string | null,
  string | null,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
];

function compactRow(t: Track): CompactRow {
  return [
    t.id,
    t.title,
    t.artist,
    t.album,
    t.duration,
    t.artwork_id,
    t.artist_id,
    t.album_id,
    t.gain_db ?? null,
  ];
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A restored row, rebuilt into a whole Track from whatever survived.
    Restored rows are unverified (text, not links) until the server
    replaces them wholesale, so the fields nothing renders yet take
    neutral defaults. Anything without an id and a title is no row. */
function restoredTrack(raw: Record<string, unknown>): Track | null {
  if (typeof raw.id !== "number" || !Number.isInteger(raw.id)) return null;
  if (typeof raw.title !== "string") return null;
  return {
    id: raw.id,
    title: raw.title,
    artist: strOrNull(raw.artist),
    artist_id: numOrNull(raw.artist_id),
    album: strOrNull(raw.album),
    album_id: numOrNull(raw.album_id),
    track_no: numOrNull(raw.track_no),
    disc_no: numOrNull(raw.disc_no),
    year: numOrNull(raw.year),
    duration: numOrNull(raw.duration) ?? 0,
    format: typeof raw.format === "string" ? raw.format : "",
    favorite: raw.favorite === true,
    artwork_id: numOrNull(raw.artwork_id),
    path: typeof raw.path === "string" ? raw.path : "",
    gain_db: numOrNull(raw.gain_db),
  };
}

function fromCompactRow(row: unknown): Track | null {
  if (!Array.isArray(row)) return null;
  const [id, title, artist, album, duration, artwork_id, artist_id, album_id, gain_db] =
    row as unknown[];
  return restoredTrack({
    id,
    title,
    artist,
    album,
    duration,
    artwork_id,
    artist_id,
    album_id,
    gain_db,
  });
}

/** Set while a restore adoption writes state: the persistence layer must
    not echo a restore back to its own writers (that would PUT on every boot
    and mark the session touched before the user has done anything). */
let restoring = false;
/** Any state change after boot is user activity — it means the local
    session has an owner and the server adoption must not clobber it. */
let sessionTouched = false;
/** False after the queue snapshot failed to save: the playhead key stops
    being written too until a queue write lands again — a playhead over a
    stale queue resumes the wrong track. */
let localQueueSaved = true;

function setStateRestoring(partial: Partial<PlayerState>): void {
  restoring = true;
  try {
    usePlayerStore.setState(partial);
  } finally {
    restoring = false;
  }
}

let queueSaveTimer: number | null = null;
let playheadSaveTimer: number | null = null;
let playheadDirty = false;

function clearLocalKeys(): void {
  try {
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem(PLAYHEAD_KEY);
  } catch {
    // best-effort, like every write here
  }
}

function writeLocalQueue(): void {
  const { queue, order, origin } = usePlayerStore.getState();
  try {
    // The origin rides the snapshot: the offline fallback layer restores
    // the same "Playing from" sentence the server's copy has.
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ v: LOCAL_QUEUE_VERSION, rows: queue.map(compactRow), order, origin }),
    );
    localQueueSaved = true;
  } catch {
    // Over quota (a very large library): this session still plays; the
    // next one starts from the server copy. Both keys go — never a
    // stale queue under a fresh playhead. Preferences live elsewhere.
    localQueueSaved = false;
    clearLocalKeys();
  }
}

function writeQueueSnapshot(keepalive = false): void {
  writeLocalQueue();
  const { queue, order, orderPos, position, origin } = usePlayerStore.getState();
  saveServerQueue({ tracks: queue, order, orderPos, position, origin }, keepalive);
}

function writePlayhead(started = false, keepalive = false): void {
  const { queue, order, orderPos, position } = usePlayerStore.getState();
  if (localQueueSaved) {
    try {
      localStorage.setItem(
        PLAYHEAD_KEY,
        JSON.stringify({ orderPos, position, savedAt: Date.now() }),
      );
    } catch {
      // Same best-effort story as the queue snapshot.
    }
  }
  // A tab that yielded playback to another tab keeps its playhead to
  // itself: the server's copy belongs to the tab that is playing.
  if (yieldedToOtherTab) return;
  const current = queue[order[orderPos]] ?? null;
  saveServerPlayhead(
    {
      orderPos,
      position,
      // The stamp rides the start-of-play sync, carrying the id —
      // never derived from the server's stored plan (a mirror PUT may
      // still be in flight there).
      ...(started && current ? { playedTrackId: current.id } : {}),
    },
    keepalive,
  );
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
    // The tab title and the lock screen follow the current track —
    // restores, clears and undos included.
    if (
      state.queue !== prev.queue ||
      state.order !== prev.order ||
      state.orderPos !== prev.orderPos
    ) {
      syncNowPlayingSurfaces();
    }
    if (restoring) return; // adoption is not user activity — don't echo it
    // A row patched in place (a heart toggled on a queued track) is not a
    // plan change: no full-queue mirror, no ownership.
    const planChanged =
      state.order !== prev.order ||
      (state.queue !== prev.queue && !sameIds(state.queue, prev.queue));
    // Session identity is the plan and the playhead. Preference writes
    // (the persist middleware's rehydration, a volume nudge) don't make
    // the session owned — they must not block the server adoption.
    if (
      planChanged ||
      state.orderPos !== prev.orderPos ||
      (state.isPlaying && !prev.isPlaying) ||
      (state.position !== prev.position && state.position > 0)
    ) {
      sessionTouched = true; // the session has an owner now
    }
    if (planChanged) {
      // Editing the plan here is acting here: this tab speaks again.
      yieldedToOtherTab = false;
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
    // Sleep, tab close, refresh: pending writes must land, and the server
    // writes must survive the tab — keepalive carries them out. Pending
    // writes only: an idle tab that changed nothing has nothing to say,
    // and writing its stale playhead on hide rewound the tab that was
    // actually playing.
    if (queueSaveTimer != null) {
      window.clearTimeout(queueSaveTimer);
      queueSaveTimer = null;
      writeQueueSnapshot(true);
    }
    const pending = playheadSaveTimer != null || playheadDirty;
    if (playheadSaveTimer != null) {
      window.clearTimeout(playheadSaveTimer);
      playheadSaveTimer = null;
    }
    playheadDirty = false;
    if (pending || (audio != null && !audio.paused)) writePlayhead(false, true);
  };
  window.addEventListener("pagehide", flushSession);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushSession();
      return;
    }
    // Back in the foreground: un-stick a context the OS suspended behind
    // the page's back (see recoverGraph).
    recoverGraph();
  });
}

/* Restore precedence: the localStorage snapshot applies synchronously
   (instant UI, click-safe), then the server's session is adopted over it
   if the local one is still untouched — an untouched first paint should
   show the server's truth, and a session already begun here is never
   clobbered. A stale local snapshot from a DIFFERENT library once
   resurrected a queue the server couldn't vouch for, so: a reachable
   server answering "empty" is authoritative for CLEARING (its localStorage
   keys go too, or the next reload resurrects the same ghosts), and rows
   restored locally are tagged unverified — surfaces render TEXT, not
   links, for them until the server replaces them wholesale. */

/** Rows the server has not vouched for. Tagged at local restore; emptied
    only by wholesale replacement (server adoption, clearing, or any live
    fetch the user makes). */
const unverifiedRows = new WeakSet<Track>();

/** True when a track object came from an unvouchable local restore:
    surfaces render text instead of links for it. Membership is fixed at
    boot, so a plain read at render time is safe — there is nothing to
    subscribe to. */
export function trackIsUnverified(track: Track | null | undefined): boolean {
  return track != null && unverifiedRows.has(track);
}

/** The local queue snapshot, in either shape — or null when there is
    none worth restoring (missing, corrupt, or any row unreadable). */
function readLocalQueue(): {
  queue: Track[];
  order: number[];
  origin: QueueOrigin | null;
  legacy: boolean;
} | null {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt snapshot: start clean
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const p = parsed as { v?: unknown; rows?: unknown; queue?: unknown; order?: unknown; origin?: unknown };
  let rows: (Track | null)[];
  let legacy = false;
  if (p.v === LOCAL_QUEUE_VERSION && Array.isArray(p.rows)) {
    rows = (p.rows as unknown[]).map(fromCompactRow);
  } else if (Array.isArray(p.queue)) {
    // v1.5.0's whole-object snapshot.
    legacy = true;
    rows = (p.queue as unknown[]).map((t) =>
      t != null && typeof t === "object" ? restoredTrack(t as Record<string, unknown>) : null,
    );
  } else {
    return null;
  }
  if (rows.length === 0 || rows.some((t) => t == null)) return null;
  const queue = rows as Track[];
  let order = Array.isArray(p.order) ? (p.order as unknown[]) : [];
  if (
    order.length !== queue.length ||
    order.some((i) => !Number.isInteger(i) || (i as number) < 0 || (i as number) >= queue.length) ||
    new Set(order).size !== order.length
  ) {
    order = queue.map((_, i) => i);
  }
  return { queue, order: order as number[], origin: parseOrigin(p.origin), legacy };
}

function restoreLocalSession(): void {
  if (typeof localStorage === "undefined") return;
  const snapshot = readLocalQueue();
  if (snapshot == null) return;
  const { queue, order, origin, legacy } = snapshot;
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
  // None of these rows are vouched for yet — the server hasn't seen
  // them. Identity tags, cleared only by wholesale replacement below.
  for (const t of queue) unverifiedRows.add(t);
  setStateRestoring({
    queue,
    order,
    orderPos,
    origin,
    // Restored sessions are always paused — the point is that state loss
    // is never TOTAL, never that sound starts uninvited. The element
    // stays empty until the first play.
    isPlaying: false,
    position: Math.min(position, track.duration || position),
    duration: track.duration || 0,
  });
  // The first load after the upgrade migrates v1.5.0's snapshot to the
  // compact shape — locally only; the server already holds this plan.
  if (legacy) writeLocalQueue();
  syncWindowTitle();
}

/** Defensive origin parse: a snapshot from before this field existed, or
    a hand-edited one, degrades to no origin — the queue itself is still
    good. */
const ORIGIN_KINDS = new Set([
  "album",
  "artist",
  "playlist",
  "filter",
  "shuffle-all",
  "manual",
]);

function parseOrigin(raw: unknown): QueueOrigin | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as { kind?: unknown; label?: unknown; href?: unknown };
  if (typeof o.kind !== "string" || !ORIGIN_KINDS.has(o.kind)) return null;
  return {
    kind: o.kind as QueueOrigin["kind"],
    label: typeof o.label === "string" ? o.label : null,
    href: typeof o.href === "string" ? o.href : null,
  };
}

/** A reachable-but-empty answer clears the session — including the local
    snapshot keys, or the next reload resurrects the same ghosts. */
function clearLocalSession(): void {
  clearLocalKeys();
  setStateRestoring({
    queue: [],
    order: [],
    orderPos: 0,
    origin: null,
    isPlaying: false,
    position: 0,
    duration: 0,
  });
  syncWindowTitle();
}

/** The boot-time adoption was refused (401: Login is on and this browser
    isn't signed in yet). It runs again once sign-in lands. */
let adoptionAwaitingAuth = false;
/** The server never answered: an `online` event is worth another try. */
let adoptionAwaitingNetwork = false;

async function adoptServerSession(attempt = 0): Promise<void> {
  const result: ServerQueueState | undefined = await fetchServerQueue();
  if (result == null) return; // defensive: a broken transport layer
  if (result.status === "unauthorized") {
    adoptionAwaitingAuth = true;
    return;
  }
  if (result.status === "unreachable") {
    // A restarting server gets two quiet retries — 8 s and 24 s — before
    // the local layer is left in charge for the outage (an `online` event
    // tries once more). Rows stay unvouchable (text, not links) until an
    // answer arrives.
    adoptionAwaitingNetwork = true;
    if (attempt < 2) {
      window.setTimeout(
        () => void adoptServerSession(attempt + 1),
        attempt === 0 ? 8000 : 24000,
      );
    }
    return;
  }
  adoptionAwaitingNetwork = false;
  if (sessionTouched) return; // this browser's session already began
  if (result.status === "empty") {
    // The server answered and its truth is "nothing is playing" —
    // authoritative for clearing, never a reason to degrade to a local
    // snapshot it cannot vouch for.
    clearLocalSession();
    return;
  }
  const { items, order, order_pos, position, origin } = result.snapshot;
  if (items.length === 0) return;
  let playOrder = order;
  if (
    !Array.isArray(playOrder) ||
    playOrder.length !== items.length ||
    playOrder.some((i) => !Number.isInteger(i) || i < 0 || i >= items.length)
  ) {
    playOrder = items.map((_, i) => i); // defensive shape
  }
  const pos = Math.min(Math.max(order_pos, 0), items.length - 1);
  const track = items[playOrder[pos]];
  if (!track) return;
  setStateRestoring({
    queue: items,
    order: playOrder,
    orderPos: pos,
    origin: parseOrigin(origin),
    // Always paused, like every restore: state loss is never total,
    // sound never starts uninvited.
    isPlaying: false,
    position: Math.max(0, Math.min(position, track.duration || position)),
    duration: track.duration || 0,
  });
  syncWindowTitle();
}

/** Sign-in landed (or the status says Login is off): adopt the server's
    session now — the boot-time attempt was refused before this browser
    had a session cookie. A no-op unless that attempt was refused. */
export function resumeServerAdoption(): void {
  if (!adoptionAwaitingAuth) return;
  adoptionAwaitingAuth = false;
  void adoptServerSession();
}

restoreLocalSession();
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (adoptionAwaitingNetwork) void adoptServerSession(2);
  });
  // The adoption must not race the persist middleware's own rehydration
  // write (shuffle/repeat land in a microtask after store creation):
  // queue behind it when it hasn't finished yet.
  if (usePlayerStore.persist.hasHydrated()) {
    void adoptServerSession();
  } else {
    usePlayerStore.persist.onFinishHydration(() => void adoptServerSession());
  }
}
