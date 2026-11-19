/* Windowed track table for the full-library Tracks view. At 10k+ rows the
   DOM holds only the visible window (~30 rows). `tracks` has one slot per
   row of the whole list; a slot is empty until its page arrives (Songs
   reads pages at random access, so the scrollbar spans the library and
   the last row is reachable), and an empty slot draws a placeholder row. The virtualizer
   binds to the shell's .shell__canvas scroll container (the pattern the
   queue drawer and the Organize grid use) — a window virtualizer never
   sees the canvas scroll and would render a frozen first window with blank
   space below it. */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Track } from "../api/types";
import { useSetFavoriteMany, useToggleFavorite } from "../api/mutations";
import { announce } from "../lib/announce";
import { useMediaQuery } from "../lib/media";
import { rowMenuPoint, useRowCursor } from "../lib/rowCursor";
import { useRowDragReorder } from "../lib/rowDrag";
import { useTrackSelection } from "../lib/selection";
import { isInteractiveControl } from "../lib/shortcuts";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/library.css";
import "../styles/editing.css";
import { SelectionBar } from "./SelectionBar";
import { TrackRow } from "./TrackRow";

/* .trackrow: 7px padding × 2 + one 24px line → fixed-height rows by design.
   Phones stack title over "artist · album" in a 54px row (library.css
   mirrors both numbers on .tracktable--virtual .trackrow). */
const ROW_HEIGHT = 38;
const ROW_HEIGHT_PHONE = 54;
const PHONE_MQ = "(max-width: 640px)";
const OVERSCAN = 12;
/** Start the next page this many rows before the loaded end runs out. */
const PREFETCH_ROWS = 200;

interface VirtualTrackTableProps {
  /** One slot per row; undefined where the row has not loaded yet. */
  tracks: readonly (Track | undefined)[];
  /** Called when the window nears the loaded end: fetch the next page
      (lists that load in order from the top). */
  onNearEnd?: () => void;
  /** Called with the rows the window covers (overscan included): load
      the pages under them (lists read at random access). */
  onRangeChange?: (start: number, end: number) => void;
  /** Scroll so that row `index` is at the top of the list. A new `nonce`
      repeats a jump to the same row. */
  jump?: { index: number; nonce: number } | null;
  /** Row activation: plays `index` within the WHOLE view — paged views
      resolve the full filter first, so the queue never stops at the loaded
      pages. */
  onPlay: (index: number) => void;
  /** Resolves the whole view for the row menu's Play item. */
  contextLoader?: () => Promise<Track[]>;
  /** Drag-to-reorder (Favorites): commit a dragged row's move.
      The gesture is the shared rowDrag hook — the same one the playlist
      table speaks. */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** True only when the gesture can write the whole list: every row is
      loaded and the view isn't narrowed by a search filter — a drag
      against a subset would re-point the unshown rows' positions. */
  reorderable?: boolean;
  /** No ordinal: the rows are a sortable list, not a numbered one. The
      index slot stays empty until hover or focus shows its play glyph
      (and the playing row its bars). */
  hideIndex?: boolean;
  /** The column head (a <TrackTableHead>), rendered as the grid's first
      row so its columnheaders name the cells below. */
  head?: ReactNode;
  /** What this list is, for screen readers: "All songs", "Favorite songs". */
  label?: string;
}

export function VirtualTrackTable({
  tracks,
  onNearEnd,
  onRangeChange,
  jump,
  onPlay,
  contextLoader,
  onMove,
  reorderable = false,
  hideIndex = false,
  head,
  label = "Songs",
}: VirtualTrackTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridId = useId();
  const rowId = (index: number) => `${gridId}-row-${index}`;
  const rowIndexBase = head != null ? 2 : 1;
  const phone = useMediaQuery(PHONE_MQ);
  const rowHeight = phone ? ROW_HEIGHT_PHONE : ROW_HEIGHT;
  // Known from the first render whenever the shell is already on screen
  // (every navigation after the first load): the virtualizer then binds to
  // the canvas in this commit, before the shell places the scroll — bound
  // a render later, it would reset a restored position to its own zero.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(() =>
    document.querySelector<HTMLElement>(".shell__canvas"),
  );
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleFavorite = useToggleFavorite();

  // The grid never scrolls itself — the shell canvas does. Binding the
  // virtualizer to the canvas keeps windowing honest inside the shared
  // scroll container.
  useLayoutEffect(() => {
    const el = containerRef.current?.closest<HTMLElement>(".shell__canvas");
    setScrollEl(el ?? null);
  }, []);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });
  // Crossing the phone breakpoint changes every row's height: re-measure.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const startIndex = virtualizer.range?.startIndex ?? -1;
  const endIndex = virtualizer.range?.endIndex ?? -1;
  useEffect(() => {
    if (endIndex >= 0 && endIndex >= tracks.length - PREFETCH_ROWS) onNearEnd?.();
  }, [endIndex, tracks.length, onNearEnd]);
  useEffect(() => {
    if (startIndex >= 0 && endIndex >= 0)
      onRangeChange?.(Math.max(0, startIndex - OVERSCAN), endIndex + OVERSCAN);
  }, [startIndex, endIndex, onRangeChange]);

  // A jump (the A to Z rail): rows are a fixed height, so the target is
  // arithmetic. The sticky head covers the first rows' worth of the canvas.
  const jumpNonce = jump?.nonce;
  useEffect(() => {
    if (jump == null || scrollEl == null || containerRef.current == null) return;
    const top =
      containerRef.current.getBoundingClientRect().top -
      scrollEl.getBoundingClientRect().top +
      scrollEl.scrollTop;
    const headEl = containerRef.current.parentElement?.querySelector<HTMLElement>(".trackhead");
    const headHeight = headEl?.offsetHeight ?? 0;
    scrollEl.scrollTo({ top: Math.max(0, top + jump.index * rowHeight - headHeight) });
    // Only a new jump moves the list, not a re-render with the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpNonce, scrollEl]);

  const play = onPlay;

  // Keyboard cursor: arrows move, Enter plays, the window follows the
  // cursor. Idempotent like the row click: the current track's row never
  // restarts. `onPlay` plays the WHOLE view, so the cursor can jump into
  // unloaded pages and still queue correctly.
  const activateAt = (index: number) => {
    const track = tracks[index];
    if (track != null && track.id === current?.id) return;
    play(index);
  };
  const canDrag = reorderable && onMove != null;
  const { cursor, onKeyDown: onCursorKeyDown, setCursor } = useRowCursor(tracks.length, activateAt, {
    // Shift+F10 / ContextMenu: the same menu right-click opens.
    onMenu: (index) => openMenuAt(index),
    // Alt+↑/↓ (Favorites): the drag-free reorder, under the same rule as
    // the drag — only while the whole list is loaded and unfiltered.
    onMove: canDrag
      ? (from, to) => {
          onMove?.(from, to);
          announce(`${tracks[from]?.title ?? "Song"} moved to position ${to + 1}.`);
        }
      : undefined,
  });
  const openMenuAt = (index: number) => {
    const track = tracks[index];
    if (!track) return;
    const { x, y } = rowMenuPoint(containerRef.current, index);
    trackMenu(track, x, y);
  };
  useEffect(() => {
    if (cursor == null || cursor < 0 || cursor >= tracks.length) return;
    virtualizer.scrollToIndex(cursor, { align: "auto" });
  }, [cursor, virtualizer, tracks.length]);

  /* Marquee selection: Cmd/Shift-click selects; the floating quiet bar
     files the selection. A shift range over rows a jump skipped loads
     them first, and the bar waits for them. */
  const selection = useTrackSelection(tracks, current?.id ?? null, onRangeChange);
  /* Title clicks play through the same whole-view resolution as the
     Play button, and any live selection dissolves with the play. */
  const playFromTitle = (index: number) => {
    selection.clear();
    const track = tracks[index];
    if (track != null && track.id === current?.id) togglePlay();
    else play(index);
  };
  /* A double-click on the row body: this row becomes the one playing.
     The current track resumes if paused and is never restarted. */
  const playFromRow = (index: number) => {
    selection.clear();
    const track = tracks[index];
    if (track != null && track.id === current?.id) {
      if (!isPlaying) togglePlay();
    } else play(index);
  };
  /* A plain click on the row body puts the keyboard cursor there (the
     arrows and Enter go on from the row you clicked); the selection
     grammar then dissolves any live pill. */
  const onRowClick: typeof selection.onRowClick = (track, index, e) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) setCursor(index);
    return selection.onRowClick(track, index, e);
  };
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const setFavoriteMany = useSetFavoriteMany();
  const allFavorite = selection.selectedTracks.every((t) => t.favorite);
  const selectionBar = selection.count > 0 && (
    <SelectionBar
      count={selection.count}
      loading={selection.loading}
      allFavorite={allFavorite}
      onAddToPlaylist={() => openAddToPlaylist(selection.selectedTracks)}
      onAddToQueue={() => {
        // The store confirms arrival with a toast; the gesture is done.
        addToQueue(selection.selectedTracks);
        selection.clear();
      }}
      onToggleFavorite={() => {
        setFavoriteMany(selection.selectedTracks, !allFavorite);
        selection.clear();
      }}
      onClear={selection.clear}
    />
  );
  /* While a selection is live, Enter plays the last-selected row;
     everything else stays the cursor grammar. */
  const onTableKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && selection.count > 0 && !isInteractiveControl(e.target as Element | null)) {
      const idx = selection.lastIndex();
      if (idx != null) {
        e.preventDefault();
        activateAt(idx);
        return;
      }
    }
    onCursorKeyDown(e);
  };

  // Row action menu (right-click / long-press) with the full loaded context.
  // A right-click on a row inside the live selection carries the whole
  // selection — the menu files every selected track at once.
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const trackMenu = useCallback(
    (track: Track, x: number, y: number) =>
      openTrackMenu({
        track,
        x,
        y,
        context: tracks.filter((t): t is Track => t != null),
        contextLoader,
        // The menu's Play is the row click: one whole-view play request,
        // never a page-by-page fetch of the filter.
        playFrom: () => {
          const index = tracks.indexOf(track);
          onPlay(index >= 0 ? index : tracks.findIndex((t) => t?.id === track.id));
        },
        selection:
          selection.count > 0 && selection.ids.has(track.id)
            ? selection.selectedTracks
            : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openTrackMenu, tracks, contextLoader, onPlay, selection.ids, selection.selectedTracks],
  );

  /* Drag-to-reorder: the shared rowDrag gesture. The displacement
     rides each row's translateY — the virtualizer's `item.start` plus the
     row's drag offset — so parting neighbors and the gap read exactly like
     the playlist table's. */
  const { drag, offsetFor, handlers } = useRowDragReorder({
    containerRef,
    enabled: canDrag,
    count: tracks.length,
    onMove: (from, to) => onMove?.(from, to),
  });

  /* The grid (see TrackTable): one focusable element around the head and
     the windowed body; aria-rowcount/aria-rowindex tell a screen reader
     the true size and position even though only ~30 rows exist in the DOM. */
  return (
    <>
      <div
        className="tracklist"
        role="grid"
        aria-label={label}
        aria-rowcount={tracks.length + rowIndexBase - 1}
        aria-activedescendant={cursor != null ? rowId(cursor) : undefined}
        aria-multiselectable={true}
        tabIndex={0}
        onKeyDown={onTableKeyDown}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          if (cursor != null) openMenuAt(cursor);
        }}
      >
        {head}
        <div
          ref={containerRef}
          className={`tracktable tracktable--all tracktable--virtual${
            hideIndex ? " tracktable--quietindex" : ""
          }${
            canDrag ? " tracktable--reorderable" : ""
          }${drag ? " tracktable--dragging" : ""}`}
          role="rowgroup"
          style={{ height: virtualizer.getTotalSize() }}
          {...handlers}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const track = tracks[item.index];
            if (!track)
              // Its page is on the way: a row-shaped placeholder holds the
              // place, so the list never jumps when the rows land.
              return (
                <div
                  key={`loading-${item.index}`}
                  className="trackrow trackrow--all trackrow--loading"
                  style={{ transform: `translateY(${item.start}px)` }}
                  aria-hidden="true"
                >
                  <span className="skeleton skeleton--line" />
                </div>
              );
            return (
              <TrackRow
                key={track.id}
                track={track}
                index={item.index}
                variant="all"
                hideIndex={hideIndex}
                isCurrent={current?.id === track.id}
                isPlaying={isPlaying}
                rowId={rowId(item.index)}
                ariaRowIndex={item.index + rowIndexBase}
                selected={selection.ids.has(track.id)}
                extraClassName={
                  [
                    cursor === item.index ? "trackrow--cursor" : "",
                    selection.ids.has(track.id) ? "trackrow--selected" : "",
                    drag?.from === item.index ? "trackrow--dragging" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                style={{
                  transform: `translateY(${item.start + offsetFor(item.index)}px)`,
                }}
                dataIdx={canDrag ? item.index : undefined}
                onActivate={play}
                onTitlePlay={playFromTitle}
                onRowPlay={playFromRow}
                onTogglePlay={togglePlay}
                onToggleFavorite={toggleFavorite}
                onTrackMenu={trackMenu}
                onSelectClick={onRowClick}
              />
            );
          })}
        </div>
      </div>
      {selectionBar}
    </>
  );
}
