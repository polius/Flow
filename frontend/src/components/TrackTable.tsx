/* Track table shared by album detail, artist detail, playlists, and search
   (§9.2). M6: row markup extracted into TrackRow so the windowed
   VirtualTrackTable (Tracks view, §11.6) renders the exact same rows —
   these variants render full detail payloads at curated scale, so they stay
   plain. Rows are playback-only (§23); editing lives in Organize. */

import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes } from "react";

import type { Track } from "../api/types";
import { useToggleFavorite } from "../api/mutations";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/library.css";
import "../styles/editing.css";
import { TrackRow, type TrackVariant } from "./TrackRow";

interface TrackTableProps {
  tracks: Track[];
  variant?: TrackVariant;
  /** Context played when a row is activated — defaults to `tracks`. */
  context?: Track[];
  /** Playlist variant: drop handler for drag-to-reorder. */
  onMove?: (fromIndex: number, toIndex: number) => void;
  /** Playlist variant: removes a track from the playlist (row button). */
  onRemoveTrack?: (track: Track) => void;
}

/* The drag image (§26): a quiet pill — grip glyph + title — matching the
   icon set's stroke voice. Built with DOM APIs because the drag image must
   be a real element in the document before setDragImage sees it. */
function buildDragChip(title: string): HTMLDivElement {
  const SVG = "http://www.w3.org/2000/svg";
  const chip = document.createElement("div");
  chip.className = "dragchip";
  const grip = document.createElementNS(SVG, "svg");
  grip.setAttribute("viewBox", "0 0 24 24");
  grip.setAttribute("width", "13");
  grip.setAttribute("height", "13");
  grip.setAttribute("fill", "none");
  grip.setAttribute("stroke", "currentColor");
  grip.setAttribute("stroke-width", "1.6");
  grip.setAttribute("stroke-linecap", "round");
  grip.setAttribute("aria-hidden", "true");
  for (const d of ["M5 9h14", "M5 15h14"]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    grip.appendChild(path);
  }
  const label = document.createElement("span");
  label.textContent = title;
  chip.append(grip, label);
  return chip;
}

export function TrackTable({
  tracks,
  variant = "all",
  context,
  onMove,
  onRemoveTrack,
}: TrackTableProps) {
  // Drag state for the playlist variant.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null); // insertion slot
  // The drag-image chip: created at dragstart, disposed at dragend.
  const chipRef = useRef<HTMLDivElement | null>(null);
  // A drag that ends by unmounting (navigation mid-drag) never fires
  // dragend — the offscreen chip would linger forever.
  useEffect(
    () => () => {
      chipRef.current?.remove();
      chipRef.current = null;
    },
    [],
  );
  // Swipe-to-remove (§25): one revealed row at a time, per table.
  const [openSwipeId, setOpenSwipeId] = useState<number | null>(null);
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleFavorite = useToggleFavorite();

  const play = (index: number) => playTracks(context ?? tracks, index);

  // Removal goes through one path so every entry point — hover minus,
  // swipe action, long-press menu — closes any revealed row first.
  const removeTrack = onRemoveTrack
    ? (track: Track) => {
        setOpenSwipeId(null);
        onRemoveTrack(track);
      }
    : undefined;

  // Row action menu (right-click / long-press): carries the table's context
  // so "Play" from the menu plays in place, and — in a playlist — the remove
  // closure the menu's danger item needs (§25).
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const trackMenu = (track: Track, x: number, y: number) =>
    openTrackMenu({
      track,
      x,
      y,
      context: context ?? tracks,
      removeFromPlaylist:
        variant === "playlist" && removeTrack ? () => removeTrack(track) : undefined,
    });

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
      // The browser's default drag image is a raw snapshot of the row —
      // hover chrome, grid columns and all (§26). The chip reads as the
      // app's own chrome in both themes, offset so it sits under the
      // pointer instead of floating off to its corner.
      const chip = buildDragChip(tracks[index].title);
      document.body.appendChild(chip);
      chipRef.current = chip;
      e.dataTransfer.setDragImage(chip, 24, 18);
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
      chipRef.current?.remove();
      chipRef.current = null;
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
        extraClassName={extraClassName}
        onActivate={play}
        onTogglePlay={togglePlay}
        onToggleFavorite={toggleFavorite}
        onTrackMenu={trackMenu}
        dragHandlers={dragHandlers(index)}
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
    );
  });

  return (
    <div
      className={`tracktable tracktable--${variant}${dragIndex != null ? " tracktable--dragging" : ""}`}
      role="table"
      aria-label="Tracks"
    >
      {rows}
    </div>
  );
}
