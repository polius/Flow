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
}

export function VirtualTrackTable({ tracks, onNearEnd }: VirtualTrackTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTracks = usePlayerStore((s) => s.playTracks);
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

  const play = useCallback(
    (index: number) => playTracks(tracks, index),
    [playTracks, tracks],
  );

  // Row action menu (right-click / long-press) with the full loaded context.
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const trackMenu = useCallback(
    (track: Track, x: number, y: number) =>
      openTrackMenu({ track, x, y, context: tracks }),
    [openTrackMenu, tracks],
  );

  return (
    <div
      ref={containerRef}
      className="tracktable tracktable--all tracktable--virtual"
      role="table"
      aria-label="Tracks"
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
