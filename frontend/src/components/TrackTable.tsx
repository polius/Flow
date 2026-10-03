/* Track table shared by album detail, artist detail, playlists, and search
   (§9.2). M6: row markup extracted into TrackRow so the windowed
   VirtualTrackTable (Tracks view, §11.6) renders the exact same rows —
   these variants render full detail payloads at curated scale, so they stay
   plain. Rows select on click (§4.1); playback is the row's Play button.

   Playlist + album reorder (§27, §9.2; albums 2026-10-03): the queue's
   press-and-drag grammar, owned by the shared useRowDragReorder hook —
   the same gesture the Favorites table speaks. Reorder is optimistic and
   the server call is the source of truth. Touch keeps the §25 grammar
   (swipe, long-press menu). */

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { QueueOrigin, Track } from "../api/types";
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
import { TrackRow, type TrackVariant } from "./TrackRow";

interface TrackTableProps {
  tracks: Track[];
  variant?: TrackVariant;
  /** Context played when a row is activated — defaults to `tracks`. */
  context?: Track[];
  /** What the queue's origin becomes when a row here starts playback
      (§1.1): the view declares it once, every row inherits it. */
  origin?: QueueOrigin | null;
  /** Reorderable table (playlist + album variants): commit a dragged row's
      move — the view owns the optimistic splice and the server call. */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** Playlist variant: removes a track from the playlist (row button). */
  onRemoveTrack?: (track: Track) => void;
  /** §2.5: suppress the index column — a result set (search) has no
      meaningful ordinal, so the slot leads with the play affordance
      instead, the way the playing row already does. One prop, not a
      fork of the table. */
  hideIndex?: boolean;
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
  const tableRef = useRef<HTMLDivElement>(null);

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
  /* §4.1: while a selection is live, Enter plays the last-selected row (in
     the table's whole context) — the one keyboard change the review allows.
     Everything else, cursor included, belongs to the §3.4 grammar. */
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

  /* Marquee selection (§4.1, Review 2): Cmd/Shift-click selects; the
     floating quiet bar files the selection. Transient by construction —
     this component's state — so navigation, a filter change, or a view
     remount clears it; Esc clears it in place (the hook's listener). */
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

  // Row action menu (right-click / long-press): carries the table's context
  // so "Play" from the menu plays in place, and — in a playlist — the remove
  // closure the menu's danger item needs (§25). When the right-clicked row
  // is part of a live selection, the menu carries the whole selection so
  // "Add to Playlist" files every selected track at once (§4.1).
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

  const reorderable = (variant === "playlist" || variant === "album") && onMove != null;

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

  return (
    <>
      <div
        ref={tableRef}
        className={`tracktable tracktable--${variant}${reorderable ? " tracktable--reorderable" : ""}${drag ? " tracktable--dragging" : ""}`}
        role="table"
        aria-label="Tracks"
        tabIndex={0}
        onKeyDown={onTableKeyDown}
        {...handlers}
        // Native image/link drag would hijack the press — the table's only
        // drag is the reorder gesture.
        onDragStart={(e) => e.preventDefault()}
      >
        {rows}
      </div>
      {selectionBar}
    </>
  );
}
