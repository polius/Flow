/* One track row, shared by the plain TrackTable and the windowed
   VirtualTrackTable (§9.2/§11.6) so the markup can't drift. State comes in
   as props — neither table owns per-row subscriptions.

   Rows are playback-only (§23): clicking a row — the title included — plays
   that track, replacing the old select-on-click / double-click-to-play /
   click-title-to-rename grammar (§15.1, superseded). The activation is
   idempotent — clicking the current track's row does nothing — so a
   habitual double-click can't flash play→pause; toggling stays with the
   play glyph, Space, and the player bar. Editing lives in Organize. */

import type { CSSProperties, HTMLAttributes } from "react";
import { Link } from "react-router";

import type { Track } from "../api/types";
import { fmtDuration } from "../lib/format";
import {
  IconHeart,
  IconHeartFill,
  IconMinus,
  IconPause,
  IconPlay,
} from "./icons";

export type TrackVariant = "album" | "all" | "artist" | "playlist";

interface TrackRowProps {
  track: Track;
  index: number;
  variant: TrackVariant;
  isCurrent: boolean;
  isPlaying: boolean;
  /** Extra marker classes (drag/drop feedback), computed by the parent. */
  extraClassName?: string;
  /** Virtual variant: absolute positioning inside the measured container. */
  style?: CSSProperties;
  /** Row activation: play this index (parent decides the play context). */
  onActivate: (index: number) => void;
  onTogglePlay: () => void;
  onToggleFavorite: (track: Track) => void;
  /** Playlist variant: drag-to-reorder handlers (§9.3). */
  dragHandlers?: HTMLAttributes<HTMLDivElement>;
  /** Playlist variant: one-click removal, hover-revealed (§9.2). */
  onRemove?: (track: Track) => void;
}

export function TrackRow({
  track,
  index,
  variant,
  isCurrent,
  isPlaying,
  extraClassName,
  style,
  onActivate,
  onTogglePlay,
  onToggleFavorite,
  dragHandlers,
  onRemove,
}: TrackRowProps) {
  const classes = [
    "trackrow",
    `trackrow--${variant}`,
    isCurrent ? "trackrow--playing" : "",
    extraClassName ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={style}
      role="row"
      onClick={() => {
        // Idempotent play (§23): never toggles — a second click (the tail of
        // a double-click, a restless re-click) must not pause.
        if (!isCurrent) onActivate(index);
      }}
      {...dragHandlers}
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
            if (isCurrent) onTogglePlay();
            else onActivate(index);
          }}
        >
          {isCurrent && isPlaying ? <IconPause size={15} /> : <IconPlay size={15} />}
        </button>
      </span>
      <span className="trackrow__title">{track.title}</span>
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
            onToggleFavorite(track);
          }}
        >
          {track.favorite ? <IconHeartFill size={15} /> : <IconHeart size={15} />}
        </button>
      </span>
      {onRemove && (
        <span className="trackrow__remove">
          <button
            type="button"
            className="trackrow__removebtn"
            aria-label={`Remove ${track.title} from this playlist`}
            title="Remove from playlist"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(track);
            }}
          >
            <IconMinus size={15} />
          </button>
        </span>
      )}
    </div>
  );
}
