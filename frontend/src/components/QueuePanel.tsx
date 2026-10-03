/* Queue drawer (§9.2, §9.4): the full queue as one continuous list in play
   order (identity or shuffled — the store's `order` is the truth). Played
   tracks stay in place, dimmed; the playing row is marked with pulsing
   accent bars over its artwork (§17.7) — nothing disappears as the queue
   advances. Rows are click-to-jump: any row starts playback from there,
   backwards included; the playing row toggles playback. The playing row is
   anchored — it can't be dragged or removed (§9.4: playback is the thing
   the user can't undo with one gesture).

   Reorder (§9.4 revision 2): one pointer grammar on every platform. On the
   mouse, press-and-move lifts a row; on touch/pen, a long press lifts it
   (the home-screen gesture). The lifted row follows the finger as a
   floating ghost while its neighbors slide out of the way — the gap where
   the row will land IS the insertion indicator. List edges auto-scroll,
   release commits once (straight into the play order, shuffle-aware), and
   Escape or a system cancel springs the row home. Before a touch lift the
   list stays native: vertical movement scrolls, a leftward move is still
   the swipe-to-remove gesture (the iOS Mail gesture), and the
   always-visible ✕ remains the discoverable path. Option+↑/↓ on a focused
   row reorders without a pointer at all. Queue manipulation only — no
   ratings, no play counts.

   The queue is also where one is BUILT (§23): the header's Add button opens
   the shared library picker and appends to the end of the play order.
   The list is windowed — playing a full library queues 10k rows.

   §1.1 (UX review 2): the queue knows where it came from. The head shows
   "Playing from …" (the session's origin, linked), and the body groups
   itself by album — a quiet divider above each run of the same album, in
   play order, only when the queue actually spans more than one album and
   the run is worth naming. Rows carry artist links: the title stays the
   click-to-jump target; the artist name is a door (§1.4). */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "react-router";

import type { Track } from "../api/types";
import { fmtDuration } from "../lib/format";
import { trackIsUnverified, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { AddTracksDialog } from "./AddTracksDialog";
import { Artwork } from "./Artwork";
import {
  IconChevronDown,
  IconClose,
  IconPause,
  IconPlay,
  IconPlus,
  IconTrash,
} from "./icons";
import "../styles/nowplaying.css";

/* .queue__row: 38px artwork + 7px padding × 2 — fixed-height rows. */
const ROW_HEIGHT = 52;
/* .queue__divider: the album-group caption row. */
const DIVIDER_HEIGHT = 33;
/** A swipe past this many pixels commits the removal. */
const SWIPE_COMMIT_PX = 96;
/** Movement below this is a tap, not a swipe. */
const SWIPE_START_PX = 8;
/** Hold-to-lift on touch/pen — the home-screen drag grammar. */
const LIFT_DELAY_MS = 350;
/** Mouse press-move slop before a drag lifts. */
const MOUSE_LIFT_PX = 5;
/** Auto-scroll edge band (px) and top speed (px per frame). */
const EDGE_PX = 56;
const EDGE_SPEED = 14;

interface DragState {
  /** Order index the row was grabbed from. */
  from: number;
  /** Tentative insertion slot (0..order.length) in the current list. */
  slot: number;
  /** Ghost width, measured from the row at lift. */
  width: number;
}

interface SettleState {
  track: Track;
  x: number;
  y: number;
  width: number;
}

/* One live pointer gesture at a time: a drag lift, a swipe-remove, or a
   native scroll. The ref is the truth between renders — the frame loop and
   the long-press timer must never read stale state. */
interface Gesture {
  pointerId: number;
  touch: boolean;
  index: number; // order index of the pressed row
  el: HTMLElement | null; // the pressed row (measured at lift)
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  decided: "none" | "drag" | "swipe" | "scroll";
  lifted: boolean;
  liftTimer: number | null;
  raf: number | null;
  esc: ((e: KeyboardEvent) => void) | null;
  grabDx: number;
  grabDy: number;
  rowWidth: number;
  rect: DOMRect | null; // list rect at lift
}

const freshGesture = (): Gesture => ({
  pointerId: -1,
  touch: false,
  index: -1,
  el: null,
  startX: 0,
  startY: 0,
  clientX: 0,
  clientY: 0,
  decided: "none",
  lifted: false,
  liftTimer: null,
  raf: null,
  esc: null,
  grabDx: 0,
  grabDy: 0,
  rowWidth: 0,
  rect: null,
});

/* ---- the §1.1 album-grouping layout -------------------------------------- */

type QueueEntry =
  | { kind: "row"; order: number; height: number }
  | { kind: "divider"; album: string; artist: string | null; height: number };

interface QueueLayout {
  entries: QueueEntry[];
  /** Play-order index → entry index (rows are 1:1 with `order`). */
  rowEntry: number[];
  /** Entry start offsets — the virtualizer's item.start, precomputed for
      the drag math (which needs a row's position without a re-render). */
  starts: number[];
  /** Bottom edge of each row, in play order — the monotonic list the
      drag's tentative-slot search bisects. */
  rowBottoms: number[];
}

/** One derived pass over the play order (§1.1: "no new components"): rows
    in play order, with a quiet divider above each run of the same album.
    Dividers appear only when the queue actually spans more than one album,
    and only above runs of two or more — a one-album queue is its own
    context (the "Playing from" line already says so), and a shuffled
    library would otherwise sprout a header above every track. A run of
    one is not a group worth naming; silence is the quiet choice. */
export function buildQueueLayout(order: number[], queue: Track[]): QueueLayout {
  const entries: QueueEntry[] = [];
  const rowEntry: number[] = [];

  const albums = new Set<number | null>();
  for (const idx of order) albums.add(queue[idx]?.album_id ?? null);
  const grouped = albums.size > 1;

  if (grouped && order.length > 0) {
    // Runs of consecutive same-album tracks in PLAY order (a null album
    // never merges — loose tracks have nothing to group under).
    const runAlbum: (number | null)[] = [];
    const runLen: number[] = [];
    for (const idx of order) {
      const a = queue[idx]?.album_id ?? null;
      const last = runAlbum.length - 1;
      if (a != null && last >= 0 && runAlbum[last] === a) runLen[last] += 1;
      else {
        runAlbum.push(a);
        runLen.push(1);
      }
    }
    let run = 0;
    let inRun = 0;
    for (let i = 0; i < order.length; i++) {
      if (inRun === 0 && i > 0 && runAlbum[run] != null && runLen[run] >= 2) {
        const t = queue[order[i]];
        entries.push({
          kind: "divider",
          album: t.album ?? "",
          artist: t.artist ?? null,
          height: DIVIDER_HEIGHT,
        });
      }
      rowEntry[i] = entries.length;
      entries.push({ kind: "row", order: i, height: ROW_HEIGHT });
      inRun += 1;
      if (inRun >= runLen[run]) {
        run += 1;
        inRun = 0;
      }
    }
  } else {
    for (let i = 0; i < order.length; i++) {
      rowEntry[i] = entries.length;
      entries.push({ kind: "row", order: i, height: ROW_HEIGHT });
    }
  }

  const starts: number[] = [];
  const rowBottoms: number[] = [];
  let at = 0;
  for (const e of entries) {
    starts.push(at);
    if (e.kind === "row") rowBottoms.push(at + ROW_HEIGHT);
    at += e.height;
  }
  return { entries, rowEntry, starts, rowBottoms };
}

/** The insertion slot nearest `y` (content coordinates): how many row
    boundaries sit above it. The uniform-height `round(y / ROW_HEIGHT)`
    this replaces can't see the dividers. */
function slotAt(rowBottoms: number[], y: number): number {
  let lo = 0;
  let hi = rowBottoms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowBottoms[mid] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface QueuePanelProps {
  /** Narrow-window sheet mode (§23): a chevron returns to the stage. */
  onCollapse?: () => void;
}

export function QueuePanel({ onCollapse }: QueuePanelProps) {
  const queue = usePlayerStore((s) => s.queue);
  const order = usePlayerStore((s) => s.order);
  const orderPos = usePlayerStore((s) => s.orderPos);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playAt = usePlayerStore((s) => s.playAt);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const restoreToQueue = usePlayerStore((s) => s.restoreToQueue);
  const moveInQueue = usePlayerStore((s) => s.moveInQueue);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  const [adding, setAdding] = useState(false);

  // Lifted-drag state (mounted → the ghost exists) and the spring-home
  // state that flies the ghost onto the committed slot after release.
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settle, setSettle] = useState<SettleState | null>(null);

  // Touch swipe-to-remove: the visual slide of the active gesture.
  const [swipe, setSwipe] = useState<{ index: number; dx: number } | null>(null);

  const gestureRef = useRef<Gesture>(freshGesture());
  const dragRef = useRef<DragState | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const settleTimerRef = useRef<number | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const lastQueueRef = useRef(queue);

  const origin = usePlayerStore((s) => s.origin);
  const closeNowPlaying = useUiStore((s) => s.closeNowPlaying);

  // The §1.1 layout: rows in play order plus album dividers, with the
  // offset arithmetic (centering, drag slots, settle flight) precomputed.
  const layout = useMemo(() => buildQueueLayout(order, queue), [order, queue]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const virtualizer = useVirtualizer({
    count: layout.entries.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => layout.entries[i]?.height ?? ROW_HEIGHT,
    overscan: 10,
  });

  // Entry sizes are static per layout, but the virtualizer caches them per
  // index — after a commit moves the dividers, clear the cache so the new
  // heights (and the rows around them) measure from the new layout.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, layout]);

  // Keep the playing row findable in the full list: center it once when the
  // drawer opens or the QUEUE is replaced, then follow it only when it
  // scrolls out of view — never yank the list while the user is reading it.
  // A reorder is not a replacement: dragging rows must not steer the
  // scroll — and nothing steers at all while a drag gesture is live.
  useEffect(() => {
    const list = listRef.current;
    if (!list || order.length === 0 || orderPos >= order.length) return;
    if (gestureRef.current.lifted) return;
    const isNewQueue = lastQueueRef.current !== queue;
    lastQueueRef.current = queue;
    const entry = layoutRef.current.rowEntry[Math.max(0, orderPos)];
    const top = entry != null ? layoutRef.current.starts[entry] : 0;
    const inView =
      top >= list.scrollTop &&
      top + ROW_HEIGHT <= list.scrollTop + list.clientHeight;
    if (mountedRef.current && !isNewQueue && inView) return;
    const smooth = mountedRef.current && !isNewQueue;
    mountedRef.current = true;
    list.scrollTo({
      top: Math.max(0, top - list.clientHeight / 2 + ROW_HEIGHT / 2),
      behavior: smooth ? "smooth" : "auto",
    });
  }, [queue, order, orderPos]);

  /* ---- the drag gesture ---- */

  const buzz = (ms: number) => {
    // Haptic tick on lift and commit where the platform allows it.
    if ("vibrate" in navigator) navigator.vibrate(ms);
  };

  // Removal with recovery (§26): the queue is client state, so the undo is
  // exact — the track goes back to its former queue index and play-order
  // slot. Both removal paths (the ✕ and the swipe commit) go through here.
  const removeWithUndo = (orderIndex: number) => {
    const state = usePlayerStore.getState();
    const queueIndex = state.order[orderIndex];
    const track = state.queue[queueIndex];
    if (track == null) return;
    removeFromQueue(queueIndex);
    showUndoNotice({
      message: `Removed “${track.title}” from the queue`,
      undo: async () => {
        restoreToQueue(orderIndex, queueIndex, track);
      },
    });
  };

  const applyDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  /** Tear down whatever gesture is live and leave a clean slate. */
  const resetGesture = () => {
    const g = gestureRef.current;
    if (g.raf != null) cancelAnimationFrame(g.raf);
    if (g.liftTimer != null) window.clearTimeout(g.liftTimer);
    if (g.esc) document.removeEventListener("keydown", g.esc);
    if (g.lifted) useUiStore.getState().setQueueDragOpen(false);
    gestureRef.current = freshGesture();
  };

  const clearLiftTimer = () => {
    const g = gestureRef.current;
    if (g.liftTimer != null) {
      window.clearTimeout(g.liftTimer);
      g.liftTimer = null;
    }
  };

  const startFrameLoop = () => {
    const frame = () => {
      const g = gestureRef.current;
      const list = listRef.current;
      if (!g.lifted || !list || !g.rect) return;
      // Edge auto-scroll: speed ramps across the band as the pointer
      // nears the rim, so a 10k-row queue stays reorderable end to end.
      const band = Math.min(EDGE_PX, list.clientHeight / 4);
      const toTop = g.clientY - (g.rect.top + band);
      const toBottom = g.clientY - (g.rect.bottom - band);
      let vy = 0;
      if (toTop < 0) vy = (toTop / band) * EDGE_SPEED;
      else if (toBottom > 0) vy = (toBottom / band) * EDGE_SPEED;
      if (vy !== 0) {
        list.scrollTop = Math.max(
          0,
          Math.min(list.scrollHeight - list.clientHeight, list.scrollTop + vy),
        );
      }
      // The ghost is positioned here and only here — one writer per frame.
      const ghost = ghostRef.current;
      if (ghost) {
        const x = Math.min(
          Math.max(g.clientX - g.grabDx, g.rect.left + 10),
          g.rect.right - g.rowWidth - 10,
        );
        ghost.style.transform = `translate(${x}px, ${g.clientY - g.grabDy}px) scale(1.03)`;
      }
      // The tentative slot: the row boundary nearest the pointer — bisected
      // against the row bottoms, since the §1.1 dividers make row positions
      // non-uniform.
      const len = usePlayerStore.getState().order.length;
      const contentY = g.clientY - g.rect.top + list.scrollTop;
      const slot = Math.max(
        0,
        Math.min(len, slotAt(layoutRef.current.rowBottoms, contentY)),
      );
      const d = dragRef.current;
      if (d && d.slot !== slot) applyDrag({ ...d, slot });
      g.raf = requestAnimationFrame(frame);
    };
    gestureRef.current.raf = requestAnimationFrame(frame);
  };

  const lift = () => {
    const g = gestureRef.current;
    const list = listRef.current;
    if (!g || g.decided === "swipe" || g.decided === "scroll" || g.lifted) return;
    const rowRect = g.el?.isConnected ? g.el.getBoundingClientRect() : null;
    if (!list || !rowRect) {
      resetGesture();
      return;
    }
    g.decided = "drag";
    g.lifted = true;
    g.grabDx = g.clientX - rowRect.left;
    g.grabDy = g.clientY - rowRect.top;
    g.rowWidth = rowRect.width;
    g.rect = list.getBoundingClientRect();
    try {
      list.setPointerCapture(g.pointerId);
    } catch {
      // The pointer may have died between down and lift — the up/cancel
      // handlers clean up either way.
    }
    buzz(10);
    applyDrag({ from: g.index, slot: g.index, width: rowRect.width });
    // The lifted row is a layer above the Now Playing takeover (§15.7):
    // Esc now belongs to the drag until it ends.
    useUiStore.getState().setQueueDragOpen(true);
    g.esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    document.addEventListener("keydown", g.esc);
    startFrameLoop();
  };

  const finish = (commit: boolean) => {
    const g = gestureRef.current;
    const d = dragRef.current;
    applyDrag(null);
    if (g.lifted && d) {
      const eff = d.slot <= d.from ? d.slot : d.slot - 1;
      const target = commit ? eff : d.from;
      // Snapshot before committing — `order` is about to change identity.
      const track = queue[order[d.from]];
      if (commit && eff !== d.from) {
        moveInQueue(d.from, d.slot);
        buzz(8);
      }
      // Fly the ghost the last few pixels onto the row's final slot (back
      // home on a cancel) — the real row is already underneath it. The
      // target's position comes from the POST-commit layout (a commit may
      // have moved dividers), rebuilt from the store's fresh state.
      const moved = commit ? eff !== d.from : d.slot !== d.from;
      if (moved && track && listRef.current) {
        const st = usePlayerStore.getState();
        const fresh = buildQueueLayout(st.order, st.queue);
        const entry = fresh.rowEntry[target] ?? -1;
        const top = entry >= 0 ? fresh.starts[entry] : target * ROW_HEIGHT;
        const r = listRef.current.getBoundingClientRect();
        setSettle({
          track,
          x: (g.rect?.left ?? r.left) + 10,
          y: r.top - listRef.current.scrollTop + top,
          width: d.width,
        });
        if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = window.setTimeout(() => setSettle(null), 220);
      }
    }
    resetGesture();
  };

  const onListPointerDown = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    // A live touch gesture owns the surface; a stale mouse arming (the
    // pointer died outside the panel) is replaced.
    if (g.pointerId !== -1 && g.touch) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest(".queue__remove")) return; // the ✕ owns its press
    const rowEl = target.closest<HTMLElement>("[data-idx]");
    if (!rowEl) return;
    const index = Number(rowEl.dataset.idx);
    if (index === orderPos) return; // the playing row is anchored (§9.4)
    resetGesture();
    gestureRef.current = {
      ...freshGesture(),
      pointerId: e.pointerId,
      touch: e.pointerType !== "mouse",
      index,
      el: rowEl,
      startX: e.clientX,
      startY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
    };
    if (gestureRef.current.touch) {
      gestureRef.current.liftTimer = window.setTimeout(lift, LIFT_DELAY_MS);
    }
  };

  const onListPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    g.clientX = e.clientX;
    g.clientY = e.clientY;
    if (g.lifted) return; // past the lift, the frame loop owns everything
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.decided === "none") {
      const slop = g.touch ? SWIPE_START_PX : MOUSE_LIFT_PX;
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) return;
      if (!g.touch) {
        lift(); // mouse: press-and-move is the whole gesture
        return;
      }
      // One decision per touch gesture: vertical belongs to the scroller,
      // rightward is nothing, leftward is the swipe-to-remove.
      if (Math.abs(dy) >= Math.abs(dx) || dx > 0) {
        g.decided = "scroll";
        resetGesture();
        return;
      }
      g.decided = "swipe";
      clearLiftTimer(); // the swipe lives on; only the lift dies here
    }
    if (g.decided === "swipe") {
      setSwipe({ index: g.index, dx: Math.min(0, Math.max(-140, dx)) });
    }
  };

  const onListPointerUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    if (g.lifted) {
      finish(true);
      return;
    }
    if (g.decided === "swipe") {
      if (swipe && swipe.dx <= -SWIPE_COMMIT_PX) {
        removeWithUndo(swipe.index);
      }
      setSwipe(null);
    }
    resetGesture();
  };

  const onListPointerCancel = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    if (g.lifted) {
      finish(false); // the system took the pointer — commit nothing
      return;
    }
    setSwipe(null);
    resetGesture();
  };

  const onListPointerLeave = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g.touch || g.lifted || g.pointerId !== e.pointerId) return;
    // A mouse pressed-but-not-lifted that leaves the panel is a dead arm.
    setSwipe(null);
    resetGesture();
  };

  // Past the lift the gesture owns vertical movement: a non-passive
  // listener is the only way to keep the scroller from taking the touch
  // back once the row is in the hand.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const block = (e: TouchEvent) => {
      if (gestureRef.current.lifted) e.preventDefault();
    };
    list.addEventListener("touchmove", block, { passive: false });
    return () => list.removeEventListener("touchmove", block);
  }, []);

  // Drop every timer and listener if the drawer unmounts mid-gesture.
  useEffect(
    () => () => {
      const g = gestureRef.current;
      if (g.raf != null) cancelAnimationFrame(g.raf);
      if (g.liftTimer != null) window.clearTimeout(g.liftTimer);
      if (g.esc) document.removeEventListener("keydown", g.esc);
      if (g.lifted) useUiStore.getState().setQueueDragOpen(false);
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  // The ghost's first paint: position it under the finger before the
  // browser gets a chance to show it anywhere else. The frame loop takes
  // over from here.
  useLayoutEffect(() => {
    const g = gestureRef.current;
    const ghost = ghostRef.current;
    if (!drag || !ghost || !g.lifted || !g.rect) return;
    const x = Math.min(
      Math.max(g.clientX - g.grabDx, g.rect.left + 10),
      g.rect.right - g.rowWidth - 10,
    );
    ghost.style.transform = `translate(${x}px, ${g.clientY - g.grabDy}px) scale(1.03)`;
  }, [drag]);

  // Displacement while a drag is live: the grabbed row's gap travels to
  // the tentative slot and neighbors between origin and slot slide one
  // row over — the same splice math moveInQueue applies on commit.
  const effSlot = drag ? (drag.slot <= drag.from ? drag.slot : drag.slot - 1) : -1;
  const shiftFor = (i: number) => {
    if (!drag) return 0;
    if (i === drag.from) return (effSlot - i) * ROW_HEIGHT;
    if (i > drag.from && i <= effSlot) return -ROW_HEIGHT;
    if (i < drag.from && i >= effSlot) return ROW_HEIGHT;
    return 0;
  };

  const ghostState = drag ?? settle;
  const ghostTrack = drag ? queue[order[drag.from]] : (settle?.track ?? null);

  return (
    <>
      <aside className="queue" id="queue-panel" aria-label="Queue">
        <header className="queue__head">
          <div className="queue__headleft">
            {onCollapse && (
              <button
                type="button"
                className="queue__back"
                onClick={onCollapse}
                aria-label="Close queue"
                title="Close queue"
              >
                <IconChevronDown size={16} />
              </button>
            )}
            <h2 className="queue__title">Queue</h2>
          </div>
          <div className="queue__headright">
            <button
              type="button"
              className="queue__add"
              onClick={() => setAdding(true)}
              aria-haspopup="dialog"
            >
              <IconPlus size={13} />
              Add
            </button>
            {order.length > 0 && (
              <span className="queue__count">
                {orderPos >= 0
                  ? `${orderPos + 1} of ${order.length}`
                  : `${order.length} ${order.length === 1 ? "track" : "tracks"}`}
              </span>
            )}
          </div>
        </header>
        {/* §1.1: the queue's origin, named next to the count. A hand-built
            queue (label null) says nothing — the pre-origin behavior.
            §2.7: the link renders only once the server has vouched for the
            session (an unverified restore's href may name a dead entity). */}
        {order.length > 0 && origin?.label != null && (
          <p className="queue__origin">
            Playing from{" "}
            {origin.href && !trackIsUnverified(queue[order[orderPos]] ?? null) ? (
              <Link
                to={origin.href}
                className="queue__originlink"
                onClick={closeNowPlaying}
              >
                {origin.label}
              </Link>
            ) : (
              <span className="queue__originname">{origin.label}</span>
            )}
          </p>
        )}

        <div
          className={`queue__list${drag ? " queue__list--dragging" : ""}`}
          ref={listRef}
          onPointerDown={onListPointerDown}
          onPointerMove={onListPointerMove}
          onPointerUp={onListPointerUp}
          onPointerCancel={onListPointerCancel}
          onPointerLeave={onListPointerLeave}
          // Native image drag (Firefox especially) would hijack the press —
          // the queue's only drag is the reorder gesture.
          onDragStart={(e) => e.preventDefault()}
        >
          {order.length === 0 ? (
            <div className="queue__empty">
              <p className="queue__emptytitle">Nothing queued</p>
              <p className="queue__emptyhint">
                Play an album or playlist anywhere in Flow — or add tracks here to
                line up what plays next.
              </p>
              <button type="button" className="queue__add" onClick={() => setAdding(true)}>
                <IconPlus size={13} />
                Add Tracks
              </button>
            </div>
          ) : (
            <div
              className="queue__window"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const entry = layout.entries[item.index];
                if (!entry) return null;
                // §1.1: the quiet album divider between runs — a plain
                // caption row, skipped by every gesture (only rows carry
                // data-idx, so it can't be dragged, swiped, or played).
                if (entry.kind === "divider") {
                  return (
                    <div
                      key={`d-${item.index}`}
                      className="queue__divider"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <span className="queue__dividername">
                        {[entry.album, entry.artist].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  );
                }
                const idx = entry.order;
                const t = queue[order[idx]];
                if (!t) return null;
                const isCurrent = idx === orderPos;
                const played = orderPos >= 0 && idx < orderPos;
                const rowClass = [
                  "queue__row",
                  isCurrent && "queue__row--current",
                  played && "queue__row--played",
                  drag?.from === idx && "queue__row--dragging",
                ]
                  .filter(Boolean)
                  .join(" ");
                const activate = () =>
                  isCurrent ? togglePlay() : playAt(idx);
                const swiping = swipe?.index === idx && swipe.dx < 0;
                return (
                  <div
                    key={`${order[idx]}-${t.id}-${idx}`}
                    data-idx={idx}
                    className={rowClass}
                    style={{
                      transform: `translateY(${item.start + shiftFor(idx)}px)`,
                    }}
                  >
                    {/* Swipe backdrop (touch): a quiet field with the remove
                        glyph, revealed as the row slides left. */}
                    <span className="queue__swipebg" aria-hidden="true">
                      <IconTrash size={15} />
                    </span>
                    <div
                      className={`queue__main${swiping ? " queue__main--swiping" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-current={isCurrent ? "true" : undefined}
                      onClick={activate}
                      onKeyDown={(e) => {
                        // A link inside the row (the artist, §1.4) owns the
                        // keyboard: Enter activates the link, never the row.
                        if (e.target instanceof Element && e.target.closest("a"))
                          return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          activate();
                          return;
                        }
                        // Pointer-free reorder: Option+↑/↓ nudges the
                        // focused row one slot at a time.
                        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                          e.preventDefault();
                          const to =
                            e.key === "ArrowUp" ? idx - 1 : idx + 1;
                          if (to < 0 || to >= order.length) return;
                          moveInQueue(idx, to < idx ? to : to + 2);
                          requestAnimationFrame(() => {
                            listRef.current
                              ?.querySelector<HTMLElement>(
                                `[data-idx="${to}"] .queue__main`,
                              )
                              ?.focus();
                          });
                        }
                      }}
                      title={isCurrent ? undefined : `Play ${t.title}`}
                      style={
                        swiping ? { transform: `translateX(${swipe.dx}px)` } : undefined
                      }
                    >
                      <div className="queue__art">
                        <Artwork artworkId={t.artwork_id} size={38} radius="s" />
                        {isCurrent && (
                          <>
                            <span className="queue__scrim" aria-hidden="true" />
                            <span
                              className={
                                isPlaying ? "eq" : "eq eq--paused"
                              }
                              aria-hidden="true"
                            >
                              <span />
                              <span />
                              <span />
                            </span>
                            <span className="queue__toggle" aria-hidden="true">
                              {isPlaying ? (
                                <IconPause size={14} />
                              ) : (
                                <IconPlay size={14} />
                              )}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="queue__meta">
                        <span className="queue__name">{t.title}</span>
                        <span className="queue__sub">
                          {!trackIsUnverified(t) && t.artist_id != null && t.artist ? (
                            // §1.4: the artist name is a door. The title
                            // keeps click-to-jump; navigation closes the
                            // takeover — the queue is inside it. §2.7: a
                            // row the server hasn't vouched for reads as
                            // text, not a link into a dead entity.
                            <Link
                              to={`/artists/${t.artist_id}`}
                              className="queue__artistlink"
                              onClick={(e) => {
                                e.stopPropagation();
                                closeNowPlaying();
                              }}
                            >
                              {t.artist}
                            </Link>
                          ) : (
                            (t.artist ?? " ")
                          )}
                        </span>
                      </div>
                      <span className="queue__time">
                        {fmtDuration(t.duration)}
                      </span>
                    </div>
                    {!isCurrent && (
                      <button
                        type="button"
                        className="queue__remove"
                        aria-label={`Remove ${t.title} from queue`}
                        title="Remove from queue"
                        onClick={() => removeWithUndo(idx)}
                      >
                        <IconClose size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* The lifted row in the hand. One element plays both roles: it
            updates in place from drag → settle, so the CSS transition flies
            it the last few pixels onto its final slot. Portaled to the body:
            fixed positioning must mean the viewport, but `.queue`'s
            backdrop-filter would otherwise become its containing block and
            double-apply the panel's origin. */}
        {ghostState &&
          ghostTrack &&
          createPortal(
            <div
              ref={ghostRef}
              className={`queue__ghost${settle ? " queue__ghost--settle" : ""}`}
              style={{
                width: ghostState.width,
                ...(settle
                  ? { transform: `translate(${settle.x}px, ${settle.y}px)` }
                  : {}),
              }}
              aria-hidden="true"
            >
              <div className="queue__art">
                <Artwork artworkId={ghostTrack.artwork_id} size={38} radius="s" />
              </div>
              <div className="queue__meta">
                <span className="queue__name">{ghostTrack.title}</span>
                <span className="queue__sub">{ghostTrack.artist ?? " "}</span>
              </div>
              <span className="queue__time">{fmtDuration(ghostTrack.duration)}</span>
            </div>,
            document.body,
          )}
      </aside>
      {adding && <AddTracksDialog kind="queue" onClose={() => setAdding(false)} />}
    </>
  );
}
