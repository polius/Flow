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
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Track } from "../api/types";
import { useToggleFavorite } from "../api/mutations";
import { useRowCursor } from "../lib/rowCursor";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/library.css";
import "../styles/editing.css";
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
}

export function VirtualTrackTable({
  tracks,
  onNearEnd,
  onPlay,
  contextLoader,
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

  // Row action menu (right-click / long-press) with the full loaded context.
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const trackMenu = useCallback(
    (track: Track, x: number, y: number) =>
      openTrackMenu({ track, x, y, context: tracks, contextLoader }),
    [openTrackMenu, tracks, contextLoader],
  );

  return (
    <div
      ref={containerRef}
      className="tracktable tracktable--all tracktable--virtual"
      role="table"
      aria-label="Tracks"
      tabIndex={0}
      onKeyDown={onCursorKeyDown}
      style={{ height: virtualizer.getTotalSize() }}
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
            extraClassName={cursor === item.index ? "trackrow--cursor" : undefined}
            style={{
              transform: `translateY(${item.start}px)`,
            }}
            onActivate={play}
            onTogglePlay={togglePlay}
            onToggleFavorite={toggleFavorite}
            onTrackMenu={trackMenu}
          />
        );
      })}
    </div>
  );
}
