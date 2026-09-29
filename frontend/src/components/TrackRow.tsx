/* One track row, shared by the plain TrackTable and the windowed
   VirtualTrackTable (§9.2/§11.6) so the markup can't drift. State comes in
   as props — neither table owns per-row subscriptions. */

import type { CSSProperties, HTMLAttributes } from "react";
import { Link } from "react-router";

import type { Track } from "../api/types";
import { fmtDuration } from "../lib/format";
import {
  IconHeart,
  IconHeartFill,
  IconMinus,
  IconMore,
  IconPause,
  IconPlay,
} from "./icons";
import { InlineEdit } from "./InlineEdit";

export type TrackVariant = "album" | "all" | "artist" | "playlist";

export interface MenuState {
  track: Track;
  x: number;
  y: number;
}

interface TrackRowProps {
  track: Track;
  index: number;
  variant: TrackVariant;
  isCurrent: boolean;
  isPlaying: boolean;
  selected: boolean;
  /** Extra marker classes (drag/drop feedback), computed by the parent. */
  extraClassName?: string;
  /** Virtual variant: absolute positioning inside the measured container. */
  style?: CSSProperties;
  /** Row activation: play this index (parent decides play vs toggle). */
  onActivate: (index: number) => void;
  onTogglePlay: () => void;
  onSelect: (track: Track) => void;
  onCommitTitle: (track: Track, title: string) => void;
  onToggleFavorite: (track: Track) => void;
  onMenu: (track: Track, x: number, y: number) => void;
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
  selected,
  extraClassName,
  style,
  onActivate,
  onTogglePlay,
  onSelect,
  onCommitTitle,
  onToggleFavorite,
  onMenu,
  dragHandlers,
  onRemove,
}: TrackRowProps) {
  const activate = () => (isCurrent ? onTogglePlay() : onActivate(index));
  const classes = [
    "trackrow",
    `trackrow--${variant}`,
    isCurrent ? "trackrow--playing" : "",
    selected && !isCurrent ? "trackrow--selected" : "",
    extraClassName ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={style}
      role="row"
      onClick={() => onSelect(track)}
      onDoubleClick={activate}
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
            activate();
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
          onCommit={(title) => onCommitTitle(track, title)}
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
            onToggleFavorite(track);
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
            onMenu(track, e.clientX, e.clientY);
          }}
        >
          <IconMore size={16} />
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
