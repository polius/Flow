/* Windowed track table for the full-library Tracks view (§9.2, §11.6).
   At 10k+ rows the DOM holds only the visible window (~30 rows). Rows come
   from an infinite query — pagination happens honestly behind the window
   (no client-side cap, no cap-less mega-payload).

   Virtualization choice: @tanstack/react-virtual — named by §9.2, headless
   (no wrapper DOM to fight the token system, §8), ~3kB, and the same
   TanStack family the project already runs for server state.

   Scroller (§22 revision): since §18 made .shell__canvas the scroll
   container, the virtualizer binds to that element (the pattern the queue
   drawer and the Organize grid use) — a window virtualizer never sees the
   canvas scroll and would render a frozen first window with blank space
   below it. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Track } from "../api/types";
import { useSetFavoriteMany, useToggleFavorite } from "../api/mutations";
import { useRowCursor } from "../lib/rowCursor";
import { useRowDragReorder } from "../lib/rowDrag";
import { useTrackSelection } from "../lib/selection";
import { isInteractiveControl } from "../lib/shortcuts";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/library.css";
import "../styles/editing.css";
import { SelectionBar } from "./SelectionBar";
import { TrackRow } from "./TrackRow";

/* .trackrow: 7px padding × 2 + one 24px line → fixed-height rows by design. */
const ROW_HEIGHT = 38;
const OVERSCAN = 12;
/** Start the next page this many rows before the loaded end runs out. */
const PREFETCH_ROWS = 200;

interface VirtualTrackTableProps {
  tracks: Track[];
  /** Called when the window nears the loaded end: fetch the next page. */
  onNearEnd: () => void;
  /** Row activation: plays `index` within the WHOLE view — paged views
      resolve the full filter first, so the queue never stops at the loaded
      pages (§29). */
  onPlay: (index: number) => void;
  /** Resolves the whole view for the row menu's Play item (§29). */
  contextLoader?: () => Promise<Track[]>;
  /** Drag-to-reorder (2026-10-03, Favorites): commit a dragged row's move.
      The gesture is the shared §27 hook — the same one the playlist table
      speaks. */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** True only when the gesture can write the whole list: every row is
      loaded and the view isn't narrowed by a search filter — a drag
      against a subset would re-point the unshown rows' positions. */
  reorderable?: boolean;
}

export function VirtualTrackTable({
  tracks,
  onNearEnd,
  onPlay,
  contextLoader,
  onMove,
  reorderable = false,
}: VirtualTrackTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleFavorite = useToggleFavorite();

  // The grid never scrolls itself — the shell canvas does (§18). Binding the
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

  const play = onPlay;

  // Keyboard cursor (§3.4): the Organize grid's Finder grammar, inherited —
  // arrows move, Enter plays, the window follows the cursor. Idempotent like
  // the row click: the current track's row never restarts. `onPlay` plays
  // the WHOLE view (§29), so the cursor can jump into unloaded pages and
  // still queue correctly.
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
    if (cursor == null || cursor < 0 || cursor >= tracks.length) return;
    virtualizer.scrollToIndex(cursor, { align: "auto" });
  }, [cursor, virtualizer, tracks.length]);

  /* Marquee selection (§4.1, Review 2): Cmd/Shift-click selects over the
     loaded rows; the floating quiet bar files the selection. The loaded
     rows are exactly the rows that can be clicked, so every selected id
     resolves to a real track here. */
  const selection = useTrackSelection(tracks);
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const setFavoriteMany = useSetFavoriteMany();
  const allFavorite = selection.selectedTracks.every((t) => t.favorite);
  const selectionBar = selection.count > 0 && (
    <SelectionBar
      count={selection.count}
      allFavorite={allFavorite}
      onAddToPlaylist={() => openAddToPlaylist(selection.selectedTracks)}
      onAddToQueue={() => {
        // The store confirms arrival (§1.2's toast); the gesture is done.
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
  /* §4.1: while a selection is live, Enter plays the last-selected row —
     the one keyboard change the review allows; everything else stays the
     §3.4 cursor grammar. */
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
  // selection — the menu files every selected track at once (§4.1).
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const trackMenu = useCallback(
    (track: Track, x: number, y: number) =>
      openTrackMenu({
        track,
        x,
        y,
        context: tracks,
        contextLoader,
        selection:
          selection.count > 0 && selection.ids.has(track.id)
            ? selection.selectedTracks
            : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openTrackMenu, tracks, contextLoader, selection.ids, selection.selectedTracks],
  );

  /* Drag-to-reorder (2026-10-03): the shared §27 gesture. The displacement
     rides each row's translateY — the virtualizer's `item.start` plus the
     row's drag offset — so parting neighbors and the gap read exactly like
     the playlist table's. */
  const canDrag = reorderable && onMove != null;
  const { drag, offsetFor, handlers } = useRowDragReorder({
    containerRef,
    enabled: canDrag,
    count: tracks.length,
    onMove: (from, to) => onMove?.(from, to),
  });

  return (
    <>
      <div
        ref={containerRef}
        className={`tracktable tracktable--all tracktable--virtual${
          canDrag ? " tracktable--reorderable" : ""
        }${drag ? " tracktable--dragging" : ""}`}
        role="table"
        aria-label="Tracks"
        tabIndex={0}
        onKeyDown={onTableKeyDown}
        style={{ height: virtualizer.getTotalSize() }}
        {...handlers}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const track = tracks[item.index];
          if (!track) return null;
          return (
            <TrackRow
              key={track.id}
              track={track}
              index={item.index}
              variant="all"
              isCurrent={current?.id === track.id}
              isPlaying={isPlaying}
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
              onTogglePlay={togglePlay}
              onToggleFavorite={toggleFavorite}
              onTrackMenu={trackMenu}
              onSelectClick={selection.onRowClick}
            />
          );
        })}
      </div>
      {selectionBar}
    </>
  );
}
