/* Track table shared by album detail, artist detail, playlists, and
   search. Row markup lives in TrackRow so the windowed VirtualTrackTable
   renders the exact same rows. A plain title click plays — dissolving
   any live pill — and modifier clicks select; playback also answers to
   the row's Play button. Playlist +
   album reorder is the queue's press-and-drag grammar, owned by the
   shared useRowDragReorder hook — optimistic, with the server call as
   the source of truth. */

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import type { QueueOrigin, Track } from "../api/types";
import { useSetFavoriteMany, useToggleFavorite } from "../api/mutations";
import { announce } from "../lib/announce";
import { rowMenuPoint, useRowCursor } from "../lib/rowCursor";
import { useRowDragReorder } from "../lib/rowDrag";
import { useTrackSelection } from "../lib/selection";
import { isInteractiveControl } from "../lib/shortcuts";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/library.css";
import "../styles/editing.css";
import { SelectionBar } from "./SelectionBar";
import { TrackRow, type TrackVariant } from "./TrackRow";

interface TrackTableProps {
  tracks: Track[];
  variant?: TrackVariant;
  /** Context played when a row is activated — defaults to `tracks`. */
  context?: Track[];
  /** What the queue's origin becomes when a row here starts playback:
      the view declares it once, every row inherits it. */
  origin?: QueueOrigin | null;
  /** Reorderable table (playlist + album variants): commit a dragged row's
      move — the view owns the optimistic splice and the server call. */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** Playlist variant: removes a track from the playlist (row button). */
  onRemoveTrack?: (track: Track) => void;
  /** Suppress the index column — a result set (search) has no
      meaningful ordinal, so the slot leads with the play affordance
      instead, the way the playing row already does. One prop, not a
      fork of the table. */
  hideIndex?: boolean;
  /** The column head (a <TrackTableHead>), rendered as the grid's first
      row so its columnheaders name the cells below. */
  head?: ReactNode;
  /** What this list is, for screen readers: "Songs on Afterglow". */
  label?: string;
}

export function TrackTable({
  tracks,
  variant = "all",
  context,
  origin,
  onMove,
  onRemoveTrack,
  hideIndex,
  head,
  label = "Songs",
}: TrackTableProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  // Row ids for aria-activedescendant; the head (when present) is row 1.
  const gridId = useId();
  const rowId = (index: number) => `${gridId}-row-${index}`;
  const rowIndexBase = head != null ? 2 : 1;

  // Swipe-to-remove: one revealed row at a time, per table.
  const [openSwipeId, setOpenSwipeId] = useState<number | null>(null);
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleFavorite = useToggleFavorite();

  const play = (index: number) => playTracks(context ?? tracks, index, origin);

  /* Keyboard cursor: Enter plays the cursor row — idempotent like the
     row click: the current track's row never restarts. Arrows keep the
     cursor visible. */
  const activateAt = (index: number) => {
    const track = tracks[index];
    if (track != null && track.id === current?.id) return;
    play(index);
  };
  const reorderable = (variant === "playlist" || variant === "album") && onMove != null;
  const { cursor, onKeyDown: onCursorKeyDown } = useRowCursor(tracks.length, activateAt, {
    // Shift+F10 / ContextMenu: the same menu right-click opens.
    onMenu: (index) => {
      const track = tracks[index];
      if (!track) return;
      const { x, y } = rowMenuPoint(tableRef.current, index);
      trackMenu(track, x, y);
    },
    // Alt+↑/↓: the drag-free reorder (WCAG 2.5.7), the queue's grammar.
    onMove: reorderable
      ? (from, to) => {
          onMove?.(from, to);
          announce(`${tracks[from]?.title ?? "Song"} moved to position ${to + 1}.`);
        }
      : undefined,
  });
  /* While a selection is live, Enter plays the last-selected row (in
     the table's whole context). Everything else, cursor included,
     belongs to the cursor grammar. */
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

  /* Marquee selection: Cmd/Shift-click selects; the
     floating quiet bar files the selection. Transient by construction —
     this component's state — so navigation, a filter change, or a view
     remount clears it; Esc clears it in place (the hook's listener). */
  const selection = useTrackSelection(tracks, current?.id ?? null);
  /* A plain title click plays — and any live selection dissolves with it
     (playing is not curation). The current track toggles pause instead
     of restarting, the Play button's contract. */
  const playFromTitle = (index: number) => {
    selection.clear();
    const track = tracks[index];
    if (track != null && track.id === current?.id) togglePlay();
    else play(index);
  };
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

  // Row action menu (right-click / long-press): carries the table's context
  // so "Play" from the menu plays in place, and — in a playlist — the remove
  // closure the menu's danger item needs. When the right-clicked row
  // is part of a live selection, the menu carries the whole selection so
  // "Add to Playlist" files every selected track at once.
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const trackMenu = (track: Track, x: number, y: number) =>
    openTrackMenu({
      track,
      x,
      y,
      context: context ?? tracks,
      origin,
      selection:
        selection.count > 0 && selection.ids.has(track.id)
          ? selection.selectedTracks
          : undefined,
      removeFromPlaylist:
        variant === "playlist" && removeTrack ? () => removeTrack(track) : undefined,
    });

  /* ---- the drag gesture (playlist + album variants, mouse) ----
     The shared hook (lib/rowDrag.ts) owns the whole press-lift-ghost-settle
     arc; the table only wears its states. Album rows have no swipe wrapper,
     so their displacement rides the row itself via `style`. */

  const { drag, offsetFor, handlers } = useRowDragReorder({
    containerRef: tableRef,
    enabled: reorderable,
    count: tracks.length,
    onMove: (from, to) => onMove?.(from, to),
    onLift: () => setOpenSwipeId(null), // dragging a revealed row closes it first
  });

  const rows = tracks.map((track, index) => (
    <TrackRow
      key={track.id}
      track={track}
      index={index}
      variant={variant}
      hideIndex={hideIndex}
      isCurrent={current?.id === track.id}
      isPlaying={isPlaying}
      rowId={rowId(index)}
      ariaRowIndex={index + rowIndexBase}
      selected={selection.ids.has(track.id)}
      extraClassName={
        [
          drag?.from === index ? "trackrow--dragging" : "",
          cursor === index ? "trackrow--cursor" : "",
          selection.ids.has(track.id) ? "trackrow--selected" : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      // The playlist's displacement rides the swipe wrapper; the album's
      // wrapper-less rows carry it on the row itself (the Favorites way).
      wrapStyle={drag ? { transform: `translateY(${offsetFor(index)}px)` } : undefined}
      style={
        variant === "album" && drag
          ? { transform: `translateY(${offsetFor(index)}px)` }
          : undefined
      }
      dataIdx={reorderable ? index : undefined}
      onActivate={play}
      onTitlePlay={playFromTitle}
      onTogglePlay={togglePlay}
      onToggleFavorite={toggleFavorite}
      onTrackMenu={trackMenu}
      onSelectClick={selection.onRowClick}
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

  /* The grid: ONE focusable element holding the head row and the body.
     Focus stays on it while the cursor moves; aria-activedescendant names
     the cursor row so a screen reader follows the arrows. A keyboard
     ContextMenu press on the grid itself (no row control focused) opens
     the cursor row's menu instead of the browser's. */
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
          if (cursor != null) {
            const track = tracks[cursor];
            const { x, y } = rowMenuPoint(tableRef.current, cursor);
            if (track) trackMenu(track, x, y);
          }
        }}
      >
        {head}
        <div
          ref={tableRef}
          className={`tracktable tracktable--${variant}${reorderable ? " tracktable--reorderable" : ""}${drag ? " tracktable--dragging" : ""}`}
          role="rowgroup"
          {...handlers}
          // Native image/link drag would hijack the press — the table's only
          // drag is the reorder gesture.
          onDragStart={(e) => e.preventDefault()}
        >
          {rows}
        </div>
      </div>
      {selectionBar}
    </>
  );
}
