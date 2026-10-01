/* Track table shared by album detail, artist detail, playlists, and search
   (§9.2). M6: row markup extracted into TrackRow so the windowed
   VirtualTrackTable (Tracks view, §11.6) renders the exact same rows —
   these variants render full detail payloads at curated scale, so they stay
   plain. Rows are playback-only (§23); editing lives in Organize.

   Playlist reorder (§27): the queue's press-and-drag grammar (§9.4 rev 2).
   Press-and-move lifts a row into a floating ghost — the row itself,
   elevated — and its origin opens into a gap that travels with the pointer;
   the neighbors part around it, and the gap is the only placement cue. The
   old HTML5 drag (static chip + 2px insertion line) is gone. Release
   settles the ghost onto the slot; Escape springs it home. Touch keeps the
   §25 grammar (swipe, long-press menu) — a touch lift would starve the
   menu timer, and the design has no Edit-mode grip to disambiguate. */

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { QueueOrigin, Track } from "../api/types";
import { useToggleFavorite } from "../api/mutations";
import { useRowCursor } from "../lib/rowCursor";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/library.css";
import "../styles/editing.css";
import { TrackRow, type TrackVariant } from "./TrackRow";

interface TrackTableProps {
  tracks: Track[];
  variant?: TrackVariant;
  /** Context played when a row is activated — defaults to `tracks`. */
  context?: Track[];
  /** What the queue's origin becomes when a row here starts playback
      (§1.1): the view declares it once, every row inherits it. */
  origin?: QueueOrigin | null;
  /** Playlist variant: drop handler for drag-to-reorder. */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** Playlist variant: removes a track from the playlist (row button). */
  onRemoveTrack?: (track: Track) => void;
  /** §2.5: suppress the index column — a result set (search) has no
      meaningful ordinal, so the slot leads with the play affordance
      instead, the way the playing row already does. One prop, not a
      fork of the table. */
  hideIndex?: boolean;
}

/** Mouse press-move slop before a drag lifts. */
const MOUSE_LIFT_PX = 5;
/** Auto-scroll edge band (px) and top speed (px per frame). */
const EDGE_PX = 56;
const EDGE_SPEED = 14;
/** The settle flight after release (matches the queue's 200ms). */
const SETTLE_MS = 200;

/* One live gesture at a time. The ref is the truth between renders — the
   frame loop must never read stale state. */
interface DragGesture {
  pointerId: number;
  from: number;
  el: HTMLElement | null; // the grabbed row wrapper (measured at lift)
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  lifted: boolean;
  grabDy: number;
  /** Measured row height — the parting rows and the slot math slide by it. */
  rowH: number;
  raf: number | null;
  esc: ((e: KeyboardEvent) => void) | null;
  canvas: HTMLElement | null; // the shell scroll container (auto-scroll)
}

const freshGesture = (): DragGesture => ({
  pointerId: -1,
  from: -1,
  el: null,
  startX: 0,
  startY: 0,
  clientX: 0,
  clientY: 0,
  lifted: false,
  grabDy: 0,
  rowH: 0,
  raf: null,
  esc: null,
  canvas: null,
});

interface DragState {
  from: number;
  /** Tentative insertion slot (0..tracks.length) in the current list. */
  slot: number;
  /** Measured row height — the parting rows slide by exactly this. */
  h: number;
}

export function TrackTable({
  tracks,
  variant = "all",
  context,
  origin,
  onMove,
  onRemoveTrack,
  hideIndex,
}: TrackTableProps) {
  // Drag state for the playlist variant (mounted → the ghost exists).
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const gestureRef = useRef<DragGesture>(freshGesture());
  const tableRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLElement | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  // A drag that ends by unmounting (navigation mid-drag) never releases.
  useEffect(
    () => () => {
      const g = gestureRef.current;
      if (g.raf != null) cancelAnimationFrame(g.raf);
      if (g.esc) document.removeEventListener("keydown", g.esc);
      ghostRef.current?.remove();
      ghostRef.current = null;
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  // Swipe-to-remove (§25): one revealed row at a time, per table.
  const [openSwipeId, setOpenSwipeId] = useState<number | null>(null);
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleFavorite = useToggleFavorite();

  const play = (index: number) => playTracks(context ?? tracks, index, origin);

  /* Keyboard cursor (§3.4): the Organize grid's Finder grammar, inherited.
     Enter plays the cursor row — idempotent like the row click: the
     current track's row never restarts. Arrows keep the cursor visible. */
  const activateAt = (index: number) => {
    const track = tracks[index];
    if (track != null && track.id === current?.id) return;
    play(index);
  };
  const { cursor, onKeyDown: onCursorKeyDown } = useRowCursor(
    tracks.length,
    activateAt,
  );
  useEffect(() => {
    if (cursor == null) return;
    tableRef.current
      ?.querySelector<HTMLElement>(`[data-rowindex="${cursor}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  // Removal goes through one path so every entry point — hover minus,
  // swipe action, long-press menu — closes any revealed row first.
  const removeTrack = onRemoveTrack
    ? (track: Track) => {
        setOpenSwipeId(null);
        onRemoveTrack(track);
      }
    : undefined;

  // Row action menu (right-click / long-press): carries the table's context
  // so "Play" from the menu plays in place, and — in a playlist — the remove
  // closure the menu's danger item needs (§25).
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const trackMenu = (track: Track, x: number, y: number) =>
    openTrackMenu({
      track,
      x,
      y,
      context: context ?? tracks,
      origin,
      removeFromPlaylist:
        variant === "playlist" && removeTrack ? () => removeTrack(track) : undefined,
    });

  /* ---- the drag gesture (playlist variant, mouse) ---- */

  const applyDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  /** Tear down whatever gesture is live and leave a clean slate. */
  const resetGesture = () => {
    const g = gestureRef.current;
    if (g.raf != null) cancelAnimationFrame(g.raf);
    if (g.esc) document.removeEventListener("keydown", g.esc);
    gestureRef.current = freshGesture();
  };

  /** Commit (or cancel): settle the ghost onto the slot, then clean up. */
  const finish = (commit: boolean) => {
    const g = gestureRef.current;
    const d = dragRef.current;
    const ghost = ghostRef.current;
    const table = tableRef.current;
    if (g.raf != null) cancelAnimationFrame(g.raf);
    if (g.esc) document.removeEventListener("keydown", g.esc);
    gestureRef.current.esc = null;
    gestureRef.current.raf = null;
    applyDrag(null);
    if (g.lifted && d && ghost && table) {
      const eff = d.slot <= d.from ? d.slot : d.slot - 1;
      // Fly the ghost the last few pixels onto the slot it lands on (back
      // onto its origin on a cancel) — the real row is already beneath it.
      const rect = table.getBoundingClientRect();
      const targetY = rect.top + (commit ? eff : d.from) * d.h;
      ghost.classList.add("trackrowghost--settle");
      ghost.style.transform = `translate(${rect.left}px, ${targetY}px) scale(1)`;
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        ghost.remove();
        ghostRef.current = null;
      }, SETTLE_MS + 40);
      if (commit && eff !== d.from) onMove?.(d.from, eff);
    }
    resetGesture();
  };

  const lift = () => {
    const g = gestureRef.current;
    const table = tableRef.current;
    const rowEl = g.el;
    if (!table || !rowEl || !rowEl.isConnected) {
      resetGesture();
      return;
    }
    const rowRect = rowEl.getBoundingClientRect();
    g.lifted = true;
    g.grabDy = g.clientY - rowRect.top;
    g.rowH = rowRect.height;
    // Pointer capture retargets the release to the table — a committed drag
    // can't leave a click behind that plays the row.
    try {
      table.setPointerCapture(g.pointerId);
    } catch {
      // The pointer may have died between down and lift — up/cancel clean up.
    }
    // The ghost: the row itself, cloned at lift and elevated. Live hover
    // chrome can't be photographed (the clone is pointer-events: none), so
    // it always reads as the row at rest.
    const inner = rowEl.querySelector<HTMLElement>(".trackrow");
    if (inner) {
      const ghost = inner.cloneNode(true) as HTMLElement;
      ghost.classList.add("trackrowghost");
      ghost.classList.remove("trackrow--dragging");
      ghost.removeAttribute("style"); // a resting swipe offset must not ride along
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.width = `${rowRect.width}px`;
      ghost.style.height = `${rowRect.height}px`;
      ghost.style.transform = `translate(${rowRect.left}px, ${rowRect.top}px)`;
      document.body.appendChild(ghost);
      ghostRef.current = ghost;
    }
    setOpenSwipeId(null); // dragging a revealed row closes it first
    applyDrag({ from: g.from, slot: g.from, h: rowRect.height });
    // Escape now belongs to the drag until it ends.
    g.esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    document.addEventListener("keydown", g.esc);
    startFrameLoop();
  };

  const startFrameLoop = () => {
    const frame = () => {
      const g = gestureRef.current;
      const table = tableRef.current;
      const ghost = ghostRef.current;
      if (!g.lifted || !table || !ghost) return;
      const rect = table.getBoundingClientRect();
      // Edge auto-scroll on the shell canvas: speed ramps across the band
      // as the pointer nears the rim — long playlists stay reorderable
      // end to end without the pointer leaving the list.
      const canvas = g.canvas;
      if (canvas) {
        const crect = canvas.getBoundingClientRect();
        const band = Math.min(EDGE_PX, crect.height / 4);
        const toTop = g.clientY - (crect.top + band);
        const toBottom = g.clientY - (crect.bottom - band);
        let vy = 0;
        if (toTop < 0) vy = (toTop / band) * EDGE_SPEED;
        else if (toBottom > 0) vy = (toBottom / band) * EDGE_SPEED;
        if (vy !== 0) {
          canvas.scrollTop = Math.max(
            0,
            Math.min(canvas.scrollHeight - canvas.clientHeight, canvas.scrollTop + vy),
          );
        }
      }
      // The ghost rides the pointer's y, locked to the list's left edge —
      // a full-width row, clamped into the table's own extent.
      const y = Math.max(
        rect.top,
        Math.min(rect.bottom - g.rowH, g.clientY - g.grabDy),
      );
      ghost.style.transform = `translate(${rect.left}px, ${y}px) scale(1.02)`;
      // The tentative slot: the row boundary nearest the pointer.
      const slot = Math.max(
        0,
        Math.min(tracks.length, Math.round((g.clientY - rect.top) / g.rowH)),
      );
      const d = dragRef.current;
      if (d && d.slot !== slot) applyDrag({ ...d, slot });
      g.raf = requestAnimationFrame(frame);
    };
    gestureRef.current.raf = requestAnimationFrame(frame);
  };

  const onTablePointerDown = (e: ReactPointerEvent) => {
    if (variant !== "playlist" || !onMove) return;
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (gestureRef.current.pointerId !== -1) return;
    if (ghostRef.current) return; // a settle is still in flight
    const target = e.target as Element;
    if (target.closest("button, a, input, textarea")) return; // their own press
    const rowEl = target.closest<HTMLElement>("[data-idx]");
    if (!rowEl || !tableRef.current?.contains(rowEl)) return;
    const from = Number(rowEl.dataset.idx);
    if (Number.isNaN(from)) return;
    resetGesture();
    gestureRef.current = {
      ...freshGesture(),
      pointerId: e.pointerId,
      from,
      el: rowEl,
      startX: e.clientX,
      startY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      canvas: tableRef.current.closest<HTMLElement>(".shell__canvas"),
    };
  };

  const onTablePointerMove = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    g.clientX = e.clientX;
    g.clientY = e.clientY;
    if (!g.lifted) {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (dx * dx + dy * dy >= MOUSE_LIFT_PX * MOUSE_LIFT_PX) lift();
    }
  };

  const onTablePointerUp = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    if (g.lifted) {
      finish(true);
      return;
    }
    resetGesture();
  };

  const onTablePointerCancel = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    if (g.lifted) {
      finish(false); // the system took the pointer — commit nothing
      return;
    }
    resetGesture();
  };

  const onTablePointerLeave = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    // A mouse pressed-but-not-lifted that leaves the table is a dead arm.
    if (g.lifted || g.pointerId !== e.pointerId) return;
    resetGesture();
  };

  // Displacement while a drag is live: the grabbed row's gap travels to
  // the tentative slot and neighbors between origin and slot slide one row
  // over — the same splice math the commit applies.
  const effSlot = drag ? (drag.slot <= drag.from ? drag.slot : drag.slot - 1) : -1;
  const shiftFor = (i: number) => {
    if (!drag) return 0;
    if (i === drag.from) return (effSlot - i) * drag.h;
    if (i > drag.from && i <= effSlot) return -drag.h;
    if (i < drag.from && i >= effSlot) return drag.h;
    return 0;
  };

  const rows = tracks.map((track, index) => (
    <TrackRow
      key={track.id}
      track={track}
      index={index}
      variant={variant}
      hideIndex={hideIndex}
      isCurrent={current?.id === track.id}
      isPlaying={isPlaying}
      extraClassName={
        [
          drag?.from === index ? "trackrow--dragging" : "",
          cursor === index ? "trackrow--cursor" : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      wrapStyle={drag ? { transform: `translateY(${shiftFor(index)}px)` } : undefined}
      dataIdx={variant === "playlist" ? index : undefined}
      onActivate={play}
      onTogglePlay={togglePlay}
      onToggleFavorite={toggleFavorite}
      onTrackMenu={trackMenu}
      onRemove={variant === "playlist" && removeTrack ? removeTrack : undefined}
      swipeOpen={variant === "playlist" && openSwipeId === track.id}
      onSwipeOpenChange={
        variant === "playlist"
          ? (open) =>
              setOpenSwipeId((cur) =>
                open ? track.id : cur === track.id ? null : cur,
              )
          : undefined
      }
    />
  ));

  return (
    <div
      ref={tableRef}
      className={`tracktable tracktable--${variant}${drag ? " tracktable--dragging" : ""}`}
      role="table"
      aria-label="Tracks"
      tabIndex={0}
      onKeyDown={onCursorKeyDown}
      onPointerDown={onTablePointerDown}
      onPointerMove={onTablePointerMove}
      onPointerUp={onTablePointerUp}
      onPointerCancel={onTablePointerCancel}
      onPointerLeave={onTablePointerLeave}
      // Native image/link drag would hijack the press — the table's only
      // drag is the reorder gesture.
      onDragStart={(e) => e.preventDefault()}
    >
      {rows}
    </div>
  );
}
