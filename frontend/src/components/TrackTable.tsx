/* Track table shared by Tracks, album detail, artist detail, and playlists
   (§9.2). M4 adds: favorite heart, hover row menu, double-click inline
   rename, and the playlist variant with drag-to-reorder (§9.3).
   Plain rows still; windowing arrives with hardening (§11.6). */

import { useState } from "react";
import { Link } from "react-router";

import type { Track } from "../api/types";
import { usePatchTrack, useToggleFavorite } from "../api/mutations";
import { fmtDuration } from "../lib/format";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import "../styles/library.css";
import "../styles/editing.css";
import {
  IconHeart,
  IconHeartFill,
  IconMore,
  IconPause,
  IconPlay,
} from "./icons";
import { InlineEdit } from "./InlineEdit";
import { TrackMenu } from "./TrackMenu";

type Variant = "album" | "all" | "artist" | "playlist";

interface TrackTableProps {
  tracks: Track[];
  variant?: Variant;
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
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
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

  const rows = tracks.map((track, index) => {
    const isCurrent = current?.id === track.id;
    const classes = [
      "trackrow",
      `trackrow--${variant}`,
      isCurrent ? "trackrow--playing" : "",
      selectedId === track.id && !isCurrent ? "trackrow--selected" : "",
      dragIndex === index ? "trackrow--dragging" : "",
      dropAt === index ? "trackrow--dropbefore" : "",
      dropAt === tracks.length && index === tracks.length - 1
        ? "trackrow--dropafter"
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div
        key={track.id}
        className={classes}
        role="row"
        onClick={() => setSelectedId(track.id)}
        onDoubleClick={() => (isCurrent ? togglePlay() : play(index))}
        draggable={variant === "playlist"}
        onDragStart={(e) => {
          if (variant !== "playlist") return;
          setDragIndex(index);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(index));
        }}
        onDragOver={(e) => {
          if (dragIndex == null || !onMove) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = e.currentTarget.getBoundingClientRect();
          setDropAt(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
        }}
        onDrop={handleDrop}
        onDragEnd={() => {
          setDragIndex(null);
          setDropAt(null);
        }}
      >
        <span className="trackrow__index" aria-hidden="true">
          <span className="trackrow__num">

            {variant === "album" ? track.track_no ?? index + 1 : index + 1}
          </span>
          <button
            type="button"
            className="trackrow__play"
            aria-label={isCurrent && isPlaying ? "Pause" : `Play ${track.title}`}
            onClick={(e) => {
              e.stopPropagation();
              isCurrent ? togglePlay() : play(index);
            }}
          >
            {isCurrent && isPlaying ? <IconPause size={15} /> : <IconPlay size={15} />}
          </button>
        </span>
        <span className="trackrow__title">
          <InlineEdit
            value={track.title}
            ariaLabel={`Rename ${track.title}`}
            className="trackrow__titletext"
            onCommit={(title) => commitTitle(track, title)}
          />
        </span>
        {variant !== "album" && (
          <span className="trackrow__secondary">
            {track.artist_id != null ? (
              <Link to={`/artists/${track.artist_id}`} onClick={(e) => e.stopPropagation()}>
                {track.artist}
              </Link>
            ) : (
              track.artist
            )}
          </span>
        )}
        {variant !== "artist" && variant !== "album" && (
          <span className="trackrow__secondary trackrow__album">
            {track.album_id != null ? (
              <Link to={`/albums/${track.album_id}`} onClick={(e) => e.stopPropagation()}>
                {track.album}
              </Link>
            ) : (
              track.album
            )}
          </span>
        )}
        <span className="trackrow__time">{fmtDuration(track.duration)}</span>
        <span className="trackrow__heart">
          <button
            type="button"
            className={`trackrow__heartbtn${track.favorite ? " trackrow__heartbtn--on" : ""}`}
            aria-label={track.favorite ? "Remove from favorites" : "Add to favorites"}
            title={track.favorite ? "Favorited" : "Favorite"}
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(track);
            }}
          >
            {track.favorite ? <IconHeartFill size={15} /> : <IconHeart size={15} />}
          </button>
        </span>
        <span className="trackrow__more">
          <button
            type="button"
            className="trackrow__morebtn"
            aria-label={`More actions for ${track.title}`}
            onClick={(e) => {
              e.stopPropagation();
              setMenu({ track, x: e.clientX, y: e.clientY });
            }}
          >
            <IconMore size={16} />
          </button>
        </span>
      </div>
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
