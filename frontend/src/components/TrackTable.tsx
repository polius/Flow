/* Track table shared by album detail, artist detail, playlists, and search
   (§9.2). M6: row markup extracted into TrackRow so the windowed
   VirtualTrackTable (Tracks view, §11.6) renders the exact same rows —
   these variants render full detail payloads at curated scale, so they stay
   plain. */

import { useState } from "react";
import type { HTMLAttributes } from "react";

import type { Track } from "../api/types";
import { usePatchTrack, useToggleFavorite } from "../api/mutations";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import "../styles/library.css";
import "../styles/editing.css";
import { TrackMenu } from "./TrackMenu";
import { TrackRow, type MenuState, type TrackVariant } from "./TrackRow";

interface TrackTableProps {
  tracks: Track[];
  variant?: TrackVariant;
  /** Context played when a row is activated — defaults to `tracks`. */
  context?: Track[];
  /** Playlist variant: drop handler for drag-to-reorder. */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** Playlist variant: removes a track from the playlist. */
  onRemoveTrack?: (track: Track) => void;
}

export function TrackTable({
  tracks,
  variant = "all",
  context,
  onMove,
  onRemoveTrack,
}: TrackTableProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Drag state for the playlist variant.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null); // insertion slot
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleFavorite = useToggleFavorite();
  const patchTrack = usePatchTrack();

  const play = (index: number) => playTracks(context ?? tracks, index);

  const commitTitle = async (track: Track, title: string) => {
    await patchTrack(track.id, { title });
  };

  const handleDrop = () => {
    if (dragIndex != null && dropAt != null && onMove) {
      let to = dropAt;
      if (to > dragIndex) to -= 1;
      if (to !== dragIndex) onMove(dragIndex, to);
    }
    setDragIndex(null);
    setDropAt(null);
  };

  const dragHandlers = (index: number): HTMLAttributes<HTMLDivElement> => ({
    draggable: variant === "playlist",
    onDragStart: (e) => {
      if (variant !== "playlist") return;
      setDragIndex(index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    },
    onDragOver: (e) => {
      if (dragIndex == null || !onMove) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      setDropAt(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
    },
    onDrop: handleDrop,
    onDragEnd: () => {
      setDragIndex(null);
      setDropAt(null);
    },
  });

  const rows = tracks.map((track, index) => {
    const extraClassName = [
      dragIndex === index ? "trackrow--dragging" : "",
      dropAt === index ? "trackrow--dropbefore" : "",
      dropAt === tracks.length && index === tracks.length - 1
        ? "trackrow--dropafter"
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <TrackRow
        key={track.id}
        track={track}
        index={index}
        variant={variant}
        isCurrent={current?.id === track.id}
        isPlaying={isPlaying}
        selected={selectedId === track.id}
        extraClassName={extraClassName}
        onActivate={play}
        onTogglePlay={togglePlay}
        onSelect={(track) => setSelectedId(track.id)}
        onCommitTitle={commitTitle}
        onToggleFavorite={toggleFavorite}
        onMenu={(track, x, y) => setMenu({ track, x, y })}
        dragHandlers={dragHandlers(index)}
      />
    );
  });

  return (
    <>
      <div className={`tracktable tracktable--${variant}`} role="table" aria-label="Tracks">
        {rows}
      </div>
      {menu && (
        <TrackMenu
          track={menu.track}
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          onRemoveFromPlaylist={
            onRemoveTrack ? () => onRemoveTrack(menu.track) : undefined
          }
        />
      )}
    </>
  );
}
