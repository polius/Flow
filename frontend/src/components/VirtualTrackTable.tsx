/* Windowed track table for the full-library Tracks view (§9.2, §11.6).
   At 10k+ rows the DOM holds only the visible window (~30 rows). Rows come
   from an infinite query — pagination happens honestly behind the window
   (no client-side cap, no cap-less mega-payload).

   The app shell's scroller is the WINDOW: the shell grid row grows with its
   content (M3–M5 reality — .shell__canvas has no internal scroll), so this
   uses useWindowVirtualizer with the table's document offset as scrollMargin.

   Virtualization choice: @tanstack/react-virtual — named by §9.2, headless
   (no wrapper DOM to fight the token system, §8), ~3kB, and the same
   TanStack family the project already runs for server state. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";

import type { Track } from "../api/types";
import { usePatchTrack, useToggleFavorite } from "../api/mutations";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import "../styles/library.css";
import "../styles/editing.css";
import { TrackMenu } from "./TrackMenu";
import { TrackRow, type MenuState } from "./TrackRow";

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
  const [scrollMargin, setScrollMargin] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleFavorite = useToggleFavorite();
  const patchTrack = usePatchTrack();

  // Distance from the document top to the table top — the window
  // virtualizer measures the document; the table starts below the header.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: tracks.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollMargin,
  });

  const endIndex = virtualizer.range?.endIndex ?? -1;
  useEffect(() => {
    if (endIndex >= 0 && endIndex >= tracks.length - PREFETCH_ROWS) onNearEnd();
  }, [endIndex, tracks.length, onNearEnd]);

  const play = useCallback(
    (index: number) => playTracks(tracks, index),
    [playTracks, tracks],
  );

  const commitTitle = useCallback(
    async (track: Track, title: string) => {
      await patchTrack(track.id, { title });
    },
    [patchTrack],
  );

  return (
    <>
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
              selected={selectedId === track.id}
              style={{
                transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
              }}
              onActivate={play}
              onTogglePlay={togglePlay}
              onSelect={(track) => setSelectedId(track.id)}
              onCommitTitle={commitTitle}
              onToggleFavorite={toggleFavorite}
              onMenu={(track, x, y) => setMenu({ track, x, y })}
            />
          );
        })}
      </div>
      {menu && (
        <TrackMenu
          track={menu.track}
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
