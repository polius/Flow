/* The Organize grid (§22): windowed rows over the full (filtered) library,
   a sticky column header, and a keyboard cursor. Columns: checkbox · № ·
   title · artist · album · genre · added · file — the fields curation
   edits, plus the two reference columns (genre feeds the Tracks filter;
   added-at answers "what did I just drop in?").

   Scroller note (§17.2 revision): the shell canvas is the app's scroll
   container (AppShell), so this uses an element virtualizer bound to
   .shell__canvas — the pattern the queue drawer uses for its list — not a
   window virtualizer.

   Drag-reorder (§22): press a row and move — inside its ALBUM block the
   row lifts, neighbors part, and release renumbers the block 1..n through
   POST /api/tracks/reorder (overlay edits, rescan-safe). The gesture is
   bounded by the album: an album is the unit the № column orders, so a
   drag can never scatter tracks across albums. Only the curated order
   (or a single album's filter) allows it — the screen must be showing the
   order the drag writes. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Track } from "../api/types";
import { IconCheck, IconChevronDown, IconMinus } from "./icons";
import { OrganizeRow, ROW_HEIGHT, type RowMods } from "./OrganizeRow";
const OVERSCAN = 12;
/** Start the next page this many rows before the loaded end runs out. */
const PREFETCH_ROWS = 200;
/** Mouse press-move slop before a drag lifts. */
const LIFT_PX = 6;

export type SelectAllState = "all" | "none" | "some";

interface OrganizeGridProps {
  tracks: Track[];
  checked: (track: Track) => boolean;
  selectAllState: SelectAllState;
  currentId: number | null;
  compact: boolean;
  /** Keyboard cursor row (explicitly focused grid). */
  cursorIndex: number | null;
  /** Track id whose title editor opens (grid Enter). */
  editTrackId: number | null;
  /** Current column sort (URL state owned by OrganizeView). */
  sort: string;
  dir: "asc" | "desc";
  onSort: (key: string, dir: "asc" | "desc") => void;
  onNearEnd: () => void;
  onToggleAll: () => void;
  onToggleRow: (track: Track, index: number, mods: RowMods) => void;
  onCursorMove: (index: number) => void;
  onCursorToggle: () => void;
  onCursorEdit: () => void;
  onOpenInfo: (track: Track) => void;
  /** Right-click: the app-wide track menu (Get Info's desktop entry). */
  onTrackMenu?: (track: Track, x: number, y: number) => void;
  onCommitTitle: (track: Track, title: string) => void;
  onCommitArtist: (track: Track, artist: string) => void;
  onCommitAlbum: (track: Track, album: string) => void;
  onCommitTrackNo: (track: Track, value: number | null) => void;
  onCommitGenre: (track: Track, genre: string) => void;
  /** Drag-reorder: true when the on-screen order is the album grouping
      (curated sort, or a single album's filter) and the grid is at full
      pointer fidelity (not the phone template). */
  canReorder: boolean;
  /** True when unloaded pages exist — an album block that runs off the
      loaded end can't be safely renumbered, so drags stay off. */
  libraryTruncated: boolean;
  onReorderBlock: (orderedIds: number[]) => void;
}

const isInteractiveTarget = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  // §16.3's guard: native activation and text editing come first.
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.tagName === "BUTTON" ||
    el.tagName === "A" ||
    el.isContentEditable
  );
};

interface DragState {
  from: number;
  /** Tentative insertion slot (block start..block end) in the list. */
  slot: number;
  /** The album block [start, end) this drag is bounded by. */
  blockStart: number;
  blockEnd: number;
}

interface DragGesture {
  pointerId: number;
  from: number;
  blockStart: number;
  blockEnd: number;
  startY: number;
  lifted: boolean;
}

export function OrganizeGrid({
  tracks,
  checked,
  selectAllState,
  currentId,
  compact,
  cursorIndex,
  editTrackId,
  sort,
  dir,
  onSort,
  onNearEnd,
  onToggleAll,
  onToggleRow,
  onCursorMove,
  onCursorToggle,
  onCursorEdit,
  onOpenInfo,
  onTrackMenu,
  onCommitTitle,
  onCommitArtist,
  onCommitAlbum,
  onCommitTrackNo,
  onCommitGenre,
  canReorder,
  libraryTruncated,
  onReorderBlock,
}: OrganizeGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const gestureRef = useRef<DragGesture | null>(null);

  // The grid itself never scrolls — the shell canvas does (§18). Binding the
  // virtualizer to the canvas keeps windowing honest inside the shared
  // scroll container.
  useLayoutEffect(() => {
    const el = containerRef.current?.closest<HTMLElement>(".shell__canvas");
    setScrollEl(el ?? null);
  }, []);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const endIndex = virtualizer.range?.endIndex ?? -1;
  useEffect(() => {
    if (endIndex >= 0 && endIndex >= tracks.length - PREFETCH_ROWS) onNearEnd();
  }, [endIndex, tracks.length, onNearEnd]);

  // The cursor stays visible without yanking the list mid-read.
  useEffect(() => {
    if (cursorIndex == null || cursorIndex < 0 || cursorIndex >= tracks.length) return;
    virtualizer.scrollToIndex(cursorIndex, { align: "auto" });
  }, [cursorIndex, virtualizer, tracks.length]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isInteractiveTarget(e.target)) return;
      const last = tracks.length - 1;
      const cursor = cursorIndex ?? -1;
      const move = (next: number) => {
        e.preventDefault();
        onCursorMove(Math.max(0, Math.min(last, next)));
      };
      switch (e.key) {
        case "ArrowDown":
          move(cursor + 1);
          break;
        case "ArrowUp":
          move(cursor <= 0 ? 0 : cursor - 1);
          break;
        case "PageDown":
          move(cursor + 20);
          break;
        case "PageUp":
          move(cursor - 20);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(last);
          break;
        case " ":
          if (cursor >= 0) {
            e.preventDefault();
            onCursorToggle();
          }
          break;
        case "a":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onToggleAll();
          }
          break;
        case "Enter":
          if (cursor >= 0) {
            e.preventDefault();
            onCursorEdit();
          }
          break;
      }
    },
    [tracks.length, cursorIndex, onCursorMove, onCursorToggle, onCursorEdit, onToggleAll],
  );

  // ---- drag-reorder within an album block (§22) ----------------------------

  const applyDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  /** The album block [start, end) around `index` — the contiguous run of
      rows sharing the row's album id. Null for loose tracks (no album). */
  const blockAround = useCallback(
    (index: number): { start: number; end: number } | null => {
      const albumId = tracks[index]?.album_id;
      if (albumId == null) return null;
      let start = index;
      while (start > 0 && tracks[start - 1]?.album_id === albumId) start -= 1;
      let end = index + 1;
      while (end < tracks.length && tracks[end]?.album_id === albumId) end += 1;
      // A block that runs off the loaded end with more library behind it
      // may be truncated — renumbering a half-read album would lie.
      if (end >= tracks.length && libraryTruncated) return null;
      return { start, end };
    },
    [tracks, libraryTruncated],
  );

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!canReorder || compact) return;
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (gestureRef.current != null || dragRef.current != null) return;
    if (isInteractiveTarget(e.target)) return;
    const rowEl = (e.target as Element).closest<HTMLElement>("[data-rowindex]");
    if (!rowEl || !containerRef.current?.contains(rowEl)) return;
    const from = Number(rowEl.dataset.rowindex);
    if (Number.isNaN(from)) return;
    const block = blockAround(from);
    if (block == null) return;
    gestureRef.current = {
      pointerId: e.pointerId,
      from,
      blockStart: block.start,
      blockEnd: block.end,
      startY: e.clientY,
      lifted: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g == null || g.pointerId !== e.pointerId) return;
    if (!g.lifted) {
      const dy = e.clientY - g.startY;
      const along = Math.abs(dy);
      if (along < LIFT_PX) return;
      if (g.blockEnd - g.blockStart < 2) {
        gestureRef.current = null; // a one-track block has nothing to reorder
        return;
      }
      g.lifted = true;
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // The pointer died between down and lift — up/cancel clean up.
      }
      applyDrag({ from: g.from, slot: g.from, blockStart: g.blockStart, blockEnd: g.blockEnd });
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const raw = Math.round((e.clientY - rect.top) / ROW_HEIGHT);
    const slot = Math.max(g.blockStart, Math.min(g.blockEnd, raw));
    const d = dragRef.current;
    if (d && d.slot !== slot) applyDrag({ ...d, slot });
  };

  const finish = (commit: boolean) => {
    const g = gestureRef.current;
    const d = dragRef.current;
    gestureRef.current = null;
    applyDrag(null);
    if (commit && g?.lifted && d) {
      // The same splice math the displacement showed: the slot is an
      // insertion point, so everything past it shifts back by one.
      const eff = d.slot <= d.from ? d.slot : d.slot - 1;
      if (eff !== d.from) {
        const ids = tracks
          .slice(d.blockStart, d.blockEnd)
          .map((t) => t.id);
        const [moved] = ids.splice(d.from - d.blockStart, 1);
        ids.splice(eff - d.blockStart, 0, moved);
        onReorderBlock(ids);
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g == null || g.pointerId !== e.pointerId) return;
    finish(g.lifted);
  };

  const onPointerCancel = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g == null || g.pointerId !== e.pointerId) return;
    finish(false);
  };

  // Displacement while a drag is live: the grabbed row's gap travels to
  // the tentative slot; neighbors between origin and slot slide one row.
  const offsetFor = (i: number): number => {
    if (!drag) return 0;
    const eff = drag.slot <= drag.from ? drag.slot : drag.slot - 1;
    if (i === drag.from) return (eff - i) * ROW_HEIGHT;
    if (i > drag.from && i <= eff) return -ROW_HEIGHT;
    if (i < drag.from && i >= eff) return ROW_HEIGHT;
    return 0;
  };

  // Column sort (Finder grammar): click a header to sort by it, click
  // again to flip. The № header restores the curate order (the grid's
  // native grouping).
  const sortClick = (key: string) => {
    if (key === "curate") {
      onSort("curate", "asc");
      return;
    }
    if (sort === key) onSort(key, dir === "asc" ? "desc" : "asc");
    else onSort(key, "asc");
  };

  const headerArrow = (key: string) =>
    sort === key ? (
      <IconChevronDown
        size={10}
        className={`orghead__arrow${dir === "asc" ? " orghead__arrow--asc" : ""}`}
      />
    ) : null;

  const headerButton = (key: string, label: string, className?: string) => (
    <button
      type="button"
      role="columnheader"
      aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`orghead__label orghead__sort${className ? ` ${className}` : ""}`}
      onClick={() => sortClick(key)}
      title={
        sort === key && key !== "curate"
          ? `Sorted by ${label} — click to reverse`
          : `Sort by ${label}`
      }
    >
      {label}
      {headerArrow(key)}
    </button>
  );

  return (
    <div
      ref={containerRef}
      className={`orggrid${drag ? " orggrid--dragging" : ""}`}
      role="grid"
      aria-label="Library tracks"
      aria-rowcount={tracks.length}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDragStart={(e) => e.preventDefault()}
    >
      <div className="orghead" role="row">
        <span className="orgrow__check orghead__check" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            role="checkbox"
            aria-checked={selectAllState === "all" ? true : selectAllState === "some" ? "mixed" : false}
            aria-label="Select all matching tracks"
            className={`orgbox${selectAllState !== "none" ? " orgbox--on" : ""}`}
            onClick={onToggleAll}
          >
            {selectAllState === "all" && <IconCheck size={11} />}
            {selectAllState === "some" && <IconMinus size={11} />}
          </button>
        </span>
        <span
          className="orghead__label orghead__no orghead__sort"
          role="columnheader"
          aria-sort={sort === "track_no" ? (dir === "asc" ? "ascending" : "descending") : "none"}
        >
          <button
            type="button"
            className="orghead__nobtn"
            onClick={() => sortClick("track_no")}
            title="Sort by track number — or reset to the curated order"
          >
            №
            {sort === "track_no" && headerArrow("track_no")}
          </button>
        </span>
        {headerButton("title", "Title")}
        {headerButton("artist", "Artist")}
        {headerButton("album", "Album")}
        {headerButton("genre", "Genre")}
        {headerButton("added_at", "Added")}
        {headerButton("path", "File")}
      </div>
      <div ref={bodyRef} className="orggrid__body" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const track = tracks[item.index];
          if (!track) return null;
          return (
            <OrganizeRow
              key={track.id}
              track={track}
              index={item.index}
              style={{ transform: `translateY(${item.start + offsetFor(item.index)}px)` }}
              checked={checked(track)}
              isCursor={cursorIndex === item.index}
              isCurrent={currentId === track.id}
              compact={compact}
              editTitle={editTrackId === track.id}
              dragging={drag?.from === item.index}
              draggable={canReorder && !compact && track.album_id != null}
              onToggle={onToggleRow}
              onOpenInfo={onOpenInfo}
              onTrackMenu={onTrackMenu}
              onCommitTitle={onCommitTitle}
              onCommitArtist={onCommitArtist}
              onCommitAlbum={onCommitAlbum}
              onCommitTrackNo={onCommitTrackNo}
              onCommitGenre={onCommitGenre}
            />
          );
        })}
      </div>
    </div>
  );
}
