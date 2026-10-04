/* Player state + audio engine — one module, deliberately. The <audio>
   elements live outside React's lifecycle so playback continues across
   navigation; the store holds state and a thin engine layer binds element
   events back into it. Restored sessions always come back paused — a
   reload never costs the listening session, and nothing autoplays. */

import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  const noun = n === 1 ? "track" : "tracks";
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
      shuffle: false,
      repeat: "off",
      soundcheck: true,
      origin: null,

      playTracks: (tracks, startIndex, origin) => {
        if (tracks.length === 0) return;
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
        errorSkipStreak = 0;
        ensureGraph();
        resumeGraph();
        const pos = Math.min(Math.max(order_pos, 0), items.length - 1);
        set({ queue: items, order, orderPos: pos, origin: origin ?? null });
        load(items[order[pos]], true);
      },

      playNext: (track) => {
        const { queue, order, orderPos } = get();
        if (queue.length === 0) {
          get().playTracks([track], 0);
          confirmArrival(1, "now", [track]); // it didn't land next — it started
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
        // An addition confirms its arrival — one quiet line, undoable.
        confirmArrival(1, "next", [track]);
      },

      playNextMany: (tracks) => {
        if (tracks.length === 0) return;
        const { queue, order, orderPos } = get();
        if (queue.length === 0) {
          get().playTracks(tracks, 0);
          confirmArrival(tracks.length, "now", tracks);
          return;
        }
        const n = tracks.length;
        const currentQueueIndex = order[orderPos];
        const newQueue = [...queue];
        newQueue.splice(currentQueueIndex + 1, 0, ...tracks);
        // Same grammar as playNext, N at a time: queue indexes past the
        // insertion point ride up by n, and the tracks take the play-order
        // slots directly after the current one — guaranteed to play in
        // order, shuffle plan otherwise untouched.
        const remapped = order.map((i) => (i > currentQueueIndex ? i + n : i));
        const slots = tracks.map((_, k) => currentQueueIndex + 1 + k);
        remapped.splice(orderPos + 1, 0, ...slots);
        set({ queue: newQueue, order: remapped, orderPos });
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
        if (audio) {
          audio.pause();
          // The standby is stale with the plan it preloaded.
          if (standbyTrack != null) resetStandby();
        }
        const noun = queue.length === 1 ? "track" : "tracks";
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
        // element: the first play resumes at the saved position.
        if (loadedSrc == null) {
          ensureGraph();
          resumeGraph();
          load(track, true, position);
          return;
        }
        if (audio.paused) {
          ensureGraph();
          resumeGraph();
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

      setSoundcheck: (on) => {
        set({ soundcheck: on });
        // The gain must follow the toggle immediately, not on next load.
        applyGain(audio, currentTrack());
        if (standbyTrack) applyGain(standby, standbyTrack);
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
      // Preferences ride the persist middleware. The queue and the
      // playhead are durable SESSION state — persisted below by the
      // hand-rolled writer, not here: the middleware re-serializes on
      // every store update, and position changes 4×/s while playing,
      // which would stringify a full-library queue at that cadence.
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

/** How close to the end (seconds) the next track starts preloading. */
const PRELOAD_AHEAD_SECONDS = 10;

const trackSrc = (track: Track): string => `/api/stream/${track.id}`;

/* There is no in-app volume or mute: iOS ignores element volume outright,
   and on desktop the media keys / hardware controls own loudness. The
   elements play at unity; the one app-level loudness control is Sound
   Check's gain below. */

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
    // The first write matches the current toggle, not the node's unity
    // default.
    applyGain(audio, currentTrack());
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
  const gain = el != null ? gainNodes.get(el) : undefined;
  if (el == null || gain == null || audioCtx == null) return;
  const { soundcheck } = usePlayerStore.getState();
  const db = soundcheck && track != null ? track.gain_db : null;
  // setTargetAtTime glides the step so a Sound Check toggle (or the first
  // apply mid-play) never clicks.
  gain.gain.setTargetAtTime(
    db != null ? Math.pow(10, db / 20) : 1,
    audioCtx.currentTime,
    0.015,
  );
}

/* -- window title ----------------------------------------------------------- */

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

function load(track: Track, autoplay: boolean, startAt?: number): void {
  if (!audio || !track) return;
  const src = trackSrc(track);
  loadedSrc = src;
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

/** The gapless switch: play the prepared standby at the ended boundary.
    Returns false when nothing usable is prepared (caller falls back). */
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
  standbyTrack = null;
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
  void audio.play().catch(() => usePlayerStore.setState({ isPlaying: false }));
  return true;
}

/* ---- Media Session — OS media keys + lock screen -------------------------- */

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

/* -- position glide ---------------------------------------------------------
   `timeupdate` fires ~4Hz: the scrubber and time label stepped rather than
   glided. While playing, a rAF loop publishes `currentTime` every frame
   instead. The persistence layer already coalesces position writes, so the
   60×/s store updates cost one throttled write per 3s, and rAF suspends
   itself when the tab hides (timeupdate keeps the state honest at 4Hz in
   the background). */

let positionRaf: number | null = null;

function stopPositionLoop(): void {
  if (positionRaf != null) {
    cancelAnimationFrame(positionRaf);
    positionRaf = null;
  }
}

function startPositionLoop(): void {
  if (positionRaf != null || typeof window === "undefined") return;
  const frame = () => {
    positionRaf = null;
    const el = audio;
    if (!el || el.paused) return; // pause/ended stop the loop via their events
    usePlayerStore.setState({ position: el.currentTime });
    positionRaf = window.requestAnimationFrame(frame);
  };
  positionRaf = window.requestAnimationFrame(frame);
}

for (const el of elements()) {
  // Every handler guards on `el !== audio`: the standby element's events
  // are machinery, never state. The one exception is its load error —
  // a failed preload must fall back to the classic advance path.
  el.addEventListener("play", () => {
    if (el !== audio) return;
    resumeGraph();
    usePlayerStore.setState({ isPlaying: true });
    errorSkipStreak = 0; // a real start — the library is alive again
    setPlaybackState("playing");
    startPositionLoop();
    // A real start is what played_at means: sync the playhead now,
    // not on the 3 s cadence, carrying the track id so the server stamps
    // the right row even while the plan mirror is still in flight.
    writePlayhead(true);
  });
  el.addEventListener("pause", () => {
    if (el !== audio) return;
    stopPositionLoop();
    usePlayerStore.setState({ isPlaying: false });
    setPlaybackState("paused");
  });
  el.addEventListener("timeupdate", () => {
    if (el !== audio) return;
    usePlayerStore.setState({ position: el.currentTime });
    if (
      Number.isFinite(el.duration) &&
      el.duration - el.currentTime <= PRELOAD_AHEAD_SECONDS
    ) {
      prepareStandby();
    }
  });
  el.addEventListener("durationchange", () => {
    if (el !== audio) return;
    usePlayerStore.setState({
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
  });
  el.addEventListener("progress", () => {
    if (el !== audio) return;
    const b = el.buffered;
    usePlayerStore.setState({
      buffered: b.length > 0 ? b.end(b.length - 1) : 0,
    });
  });
  el.addEventListener("ended", () => {
    if (el !== audio) return;
    const state = usePlayerStore.getState();
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
    const state = usePlayerStore.getState();
    const track = state.queue[state.order[state.orderPos]];
    // A stale event for an already-replaced source must not skip twice.
    // (audio.currentSrc is absolute and unsettled during failed loads —
    // the engine's own record of the requested URL is the truth.)
    if (track == null || loadedSrc !== trackSrc(track)) return;
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
   convenience the layer exists for. */

const QUEUE_KEY = "flow.player.queue";
const PLAYHEAD_KEY = "flow.player.playhead";
const QUEUE_SAVE_DEBOUNCE_MS = 400;
const PLAYHEAD_SAVE_INTERVAL_MS = 3000;

/** Set while a restore adoption writes state: the persistence layer must
    not echo a restore back to its own writers (that would PUT on every boot
    and mark the session touched before the user has done anything). */
let restoring = false;
/** Any state change after boot is user activity — it means the local
    session has an owner and the server adoption must not clobber it. */
let sessionTouched = false;

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

function writeQueueSnapshot(keepalive = false): void {
  const { queue, order, orderPos, position, origin } = usePlayerStore.getState();
  try {
    // The origin rides the snapshot: the offline fallback layer restores
    // the same "Playing from" sentence the server's copy has.
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ queue, order, origin }),
    );
  } catch {
    // Over quota (a very large library): this session still plays; the
    // next one starts from the server copy. Preferences live in the other
    // key either way.
  }
  saveServerQueue({ tracks: queue, order, orderPos, position, origin }, keepalive);
}

function writePlayhead(started = false, keepalive = false): void {
  const { queue, order, orderPos, position } = usePlayerStore.getState();
  try {
    localStorage.setItem(
      PLAYHEAD_KEY,
      JSON.stringify({ orderPos, position, savedAt: Date.now() }),
    );
  } catch {
    // Same best-effort story as the queue snapshot.
  }
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
    if (restoring) return; // adoption is not user activity — don't echo it
    // Session identity is the plan and the playhead. Preference writes
    // (the persist middleware's rehydration, a volume nudge) don't make
    // the session owned — they must not block the server adoption.
    if (
      state.queue !== prev.queue ||
      state.order !== prev.order ||
      state.orderPos !== prev.orderPos ||
      (state.isPlaying && !prev.isPlaying) ||
      (state.position !== prev.position && state.position > 0)
    ) {
      sessionTouched = true; // the session has an owner now
    }
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
    // Sleep, tab close, refresh: the playhead must be current, and the
    // server writes must survive the tab — keepalive carries them out.
    if (queueSaveTimer != null) {
      window.clearTimeout(queueSaveTimer);
      queueSaveTimer = null;
      writeQueueSnapshot(true);
    }
    if (playheadSaveTimer != null) {
      window.clearTimeout(playheadSaveTimer);
      playheadSaveTimer = null;
    }
    playheadDirty = false;
    writePlayhead(false, true);
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

function restoreLocalSession(): void {
  if (typeof localStorage === "undefined") return;
  let queue: Track[] = [];
  let order: number[] = [];
  let origin: QueueOrigin | null = null;
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      queue?: unknown;
      order?: unknown;
      origin?: unknown;
    };
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.order)) return;
    queue = parsed.queue as Track[];
    order = parsed.order as number[];
    origin = parseOrigin(parsed.origin);
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
  try {
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem(PLAYHEAD_KEY);
  } catch {
    // best-effort, like every write here
  }
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

async function adoptServerSession(attempt = 0): Promise<void> {
  const result: ServerQueueState | undefined = await fetchServerQueue();
  if (result == null) return; // defensive: a broken transport layer
  if (result.status === "unreachable") {
    // A restarting server gets two quiet retries — 8 s and 24 s — before
    // the local layer is left in charge for the outage. Rows stay
    // unvouchable (text, not links) until an answer arrives.
    if (attempt < 2) {
      window.setTimeout(
        () => void adoptServerSession(attempt + 1),
        attempt === 0 ? 8000 : 24000,
      );
    }
    return;
  }
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

restoreLocalSession();
if (typeof window !== "undefined") {
  // The adoption must not race the persist middleware's own rehydration
  // write (volume/shuffle/repeat land in a microtask after store creation):
  // queue behind it when it hasn't finished yet.
  if (usePlayerStore.persist.hasHydrated()) {
    void adoptServerSession();
  } else {
    usePlayerStore.persist.onFinishHydration(() => void adoptServerSession());
  }
}
