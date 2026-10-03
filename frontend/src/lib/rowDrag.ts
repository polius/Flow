/* Press-and-drag row reorder (§27): the gesture the playlist table speaks,
   extracted (2026-10-03) so every reorderable row list says the same thing
   — the queue drawer's grammar, now shared by TrackTable (playlists) and
   VirtualTrackTable (Favorites).

   Press-and-move lifts a row into a floating ghost — the row itself,
   elevated — and its origin opens into a gap that travels with the
   pointer; the neighbors part around it, and the gap is the only placement
   cue. Release settles the ghost onto the slot; Escape springs it home.
   Mouse only: touch keeps the §25 grammar (a touch lift would starve the
   long-press menu timer, and the design has no Edit-mode grip to
   disambiguate).

   The owning table finds the pressed row by `[data-idx]` (TrackRow's
   wrapper or the row itself), finds the visual row inside it as
   `.trackrow` for the ghost clone, and positions rows with `offsetFor`. */

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

/** Mouse press-move slop before a drag lifts. */
const MOUSE_LIFT_PX = 5;
/** Auto-scroll edge band (px) and top speed (px per frame). */
const EDGE_PX = 56;
const EDGE_SPEED = 14;
/** The settle flight after release (matches the queue's 200ms). */
const SETTLE_MS = 200;

export interface RowDragState {
  from: number;
  /** Tentative insertion slot (0..count) in the current list. */
  slot: number;
  /** Measured row height — the parting rows slide by exactly this. */
  h: number;
}

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

export interface RowDragOptions {
  /** The reorderable list's container — pointer capture, slot math, and
      ghost positioning all measure against it. */
  containerRef: RefObject<HTMLElement | null>;
  /** False refuses to start a gesture (rows keep their plain click). */
  enabled: boolean;
  /** Row count — the slot clamp. Read through a ref so the frame loop
      never sees a stale length. */
  count: number;
  /** Commit: `from` moves to insertion slot `to` (the splice math the
      displacement showed). */
  onMove: (fromIndex: number, toIndex: number) => void;
  /** Called once per lift — the table closes a revealed swipe row first. */
  onLift?: () => void;
}

export function useRowDragReorder({ containerRef, enabled, count, onMove, onLift }: RowDragOptions) {
  const [drag, setDrag] = useState<RowDragState | null>(null);
  const dragRef = useRef<RowDragState | null>(null);
  const gestureRef = useRef<DragGesture>(freshGesture());
  const ghostRef = useRef<HTMLElement | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const countRef = useRef(count);
  countRef.current = count;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onLiftRef = useRef(onLift);
  onLiftRef.current = onLift;

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

  const applyDrag = (next: RowDragState | null) => {
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
    const table = containerRef.current;
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
      if (commit && eff !== d.from) onMoveRef.current(d.from, eff);
    }
    resetGesture();
  };

  const lift = () => {
    const g = gestureRef.current;
    const table = containerRef.current;
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
    // it always reads as the row at rest. A wrapper-less row (Favorites) IS
    // the .trackrow — clone it directly.
    const inner = rowEl.classList.contains("trackrow")
      ? rowEl
      : rowEl.querySelector<HTMLElement>(".trackrow");
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
    onLiftRef.current?.(); // e.g. the playlist table closes a revealed swipe row
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
      const table = containerRef.current;
      const ghost = ghostRef.current;
      if (!g.lifted || !table || !ghost) return;
      const rect = table.getBoundingClientRect();
      // Edge auto-scroll on the shell canvas: speed ramps across the band
      // as the pointer nears the rim — long lists stay reorderable end to
      // end without the pointer leaving the list.
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
        Math.min(countRef.current, Math.round((g.clientY - rect.top) / g.rowH)),
      );
      const d = dragRef.current;
      if (d && d.slot !== slot) applyDrag({ ...d, slot });
      g.raf = requestAnimationFrame(frame);
    };
    gestureRef.current.raf = requestAnimationFrame(frame);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled) return;
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (gestureRef.current.pointerId !== -1) return;
    if (ghostRef.current) return; // a settle is still in flight
    const target = e.target as Element;
    if (target.closest("button, a, input, textarea")) return; // their own press
    const rowEl = target.closest<HTMLElement>("[data-idx]");
    if (!rowEl || !containerRef.current?.contains(rowEl)) return;
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
      canvas: containerRef.current?.closest<HTMLElement>(".shell__canvas") ?? null,
    };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
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

  const onPointerUp = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    if (g.lifted) {
      finish(true);
      return;
    }
    resetGesture();
  };

  const onPointerCancel = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    if (g.lifted) {
      finish(false); // the system took the pointer — commit nothing
      return;
    }
    resetGesture();
  };

  const onPointerLeave = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    // A mouse pressed-but-not-lifted that leaves the list is a dead arm.
    if (g.lifted || g.pointerId !== e.pointerId) return;
    resetGesture();
  };

  // Displacement while a drag is live: the grabbed row's gap travels to
  // the tentative slot and neighbors between origin and slot slide one row
  // over — the same splice math the commit applies.
  const offsetFor = (index: number): number => {
    if (!drag) return 0;
    const eff = drag.slot <= drag.from ? drag.slot : drag.slot - 1;
    if (index === drag.from) return (eff - index) * drag.h;
    if (index > drag.from && index <= eff) return -drag.h;
    if (index < drag.from && index >= eff) return drag.h;
    return 0;
  };

  return {
    drag,
    offsetFor,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
    },
  };
}
