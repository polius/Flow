/* One track row, shared by the plain TrackTable and the windowed
   VirtualTrackTable (§9.2/§11.6) so the markup can't drift. State comes in
   as props — neither table owns per-row subscriptions.

   Rows are playback-only (§23): clicking a row — the title included — plays
   that track, replacing the old select-on-click / double-click-to-play /
   click-title-to-rename grammar (§15.1, superseded). The activation is
   idempotent — clicking the current track's row does nothing — so a
   habitual double-click can't flash play→pause; toggling stays with the
   play glyph, Space, and the player bar. Editing lives in Organize. */

import { useRef } from "react";
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

const LONG_PRESS_MS = 480;
const LONG_PRESS_MOVE_PX = 10;

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
  /** Opens the row action menu (right-click / long-press, see TrackActionsMenu). */
  onTrackMenu?: (track: Track, x: number, y: number) => void;
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
  onTrackMenu,
  dragHandlers,
  onRemove,
}: TrackRowProps) {
  // Long-press → action menu (the touch path for everything the desktop row
  // reveals on hover). The press that opens the menu must not also play the
  // track, so the row swallows the click the gesture leaves behind.
  const pressRef = useRef<{
    timer: number | null;
    x: number;
    y: number;
    fired: boolean;
  }>({ timer: null, x: 0, y: 0, fired: false });

  const clearPress = () => {
    if (pressRef.current.timer != null) {
      window.clearTimeout(pressRef.current.timer);
      pressRef.current.timer = null;
    }
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (!onTrackMenu || e.touches.length !== 1) return;
    const t = e.touches[0];
    pressRef.current = { timer: null, x: t.clientX, y: t.clientY, fired: false };
    pressRef.current.timer = window.setTimeout(() => {
      pressRef.current.fired = true;
      onTrackMenu(track, pressRef.current.x, pressRef.current.y);
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (pressRef.current.timer == null) return;
    const t = e.touches[0];
    const dx = t.clientX - pressRef.current.x;
    const dy = t.clientY - pressRef.current.y;
    // Any real movement cancels: scrolling is not a menu request.
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) clearPress();
  };

  const onTouchEnd = () => clearPress();

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
        // a double-click, a restless re-click) must not pause. The click a
        // long-press leaves behind is swallowed too.
        if (pressRef.current.fired) {
          pressRef.current.fired = false;
          return;
        }
        if (!isCurrent) onActivate(index);
      }}
      onContextMenu={
        onTrackMenu
          ? (e) => {
              e.preventDefault();
              onTrackMenu(track, e.clientX, e.clientY);
            }
          : undefined
      }
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
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
