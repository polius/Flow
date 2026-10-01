/* One track row, shared by the plain TrackTable and the windowed
   VirtualTrackTable (§9.2/§11.6) so the markup can't drift. State comes in
   as props — neither table owns per-row subscriptions.

   Rows are playback-only (§23): clicking a row — the title included — plays
   that track, replacing the old select-on-click / double-click-to-play /
   click-title-to-rename grammar (§15.1, superseded). The activation is
   idempotent — clicking the current track's row does nothing — so a
   habitual double-click can't flash play→pause; toggling stays with the
   play glyph, Space, and the player bar. Editing lives in Organize.

   Playlist rows (§25): the hover-revealed minus stays the desktop path; on
   touch the row is swipeable — a leftward drag reveals the Remove action
   behind the content (iOS Mail's partial-swipe grammar). The gesture never
   deletes by itself: the drag opens the action, the tap commits it. */

import { useEffect, useRef, useState } from "react";
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

/* Swipe-to-remove (§25): 84px of revealed action; a horizontal drag locks
   as a swipe past 8px (vertical scroll still owns its gestures via
   touch-action: pan-y); release opens at half-reveal or on a leftward
   flick; the pull resists 25% past both ends, hard-capped. */
const SWIPE_REVEAL_PX = 84;
const SWIPE_LOCK_PX = 8;
const SWIPE_OPEN_RATIO = 0.5;
const SWIPE_FLICK_PX_MS = 0.4;
const SWIPE_OVERPULL_PX = 56;

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
  /** Playlist variant: one-click removal (hover-revealed on desktop,
      swipe-revealed on touch — §25). */
  onRemove?: (track: Track) => void;
  /** Whether this row's remove action is currently revealed (one open row
      per table, owned by the parent). */
  swipeOpen?: boolean;
  /** Reports open/close so the parent can close the previously open row. */
  onSwipeOpenChange?: (open: boolean) => void;
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
  swipeOpen = false,
  onSwipeOpenChange,
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

  // Swipe-to-remove (§25): the gesture tracks the finger by writing the
  // transform directly — state only marks the two phase edges (locked,
  // released), never the sixty frames between them.
  const swipeable = onRemove != null;
  const [swiping, setSwiping] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<{
    baseX: number;
    startX: number;
    startY: number;
    startedAt: number;
    locked: boolean;
    x: number;
  } | null>(null);
  // The click a swipe leaves behind must not play the track — same swallow
  // rule as the long-press click. Reset on every touchstart so a synthetic
  // click that never arrives can't eat the next real tap.
  const swipedRef = useRef(false);

  const setSwipeX = (x: number) => {
    if (contentRef.current) {
      contentRef.current.style.transform = x === 0 ? "" : `translateX(${x}px)`;
    }
  };

  // The open state owns the rest position. A row that closed from outside
  // its own gesture — another row's swipe opened, the track was removed —
  // must slide back even though no handler will fire.
  useEffect(() => {
    if (!swipeable) return;
    setSwipeX(swipeOpen ? -SWIPE_REVEAL_PX : 0);
  }, [swipeOpen, swipeable]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (!onTrackMenu && !swipeable) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (onTrackMenu) {
      pressRef.current = { timer: null, x: t.clientX, y: t.clientY, fired: false };
      pressRef.current.timer = window.setTimeout(() => {
        pressRef.current.fired = true;
        onTrackMenu(track, pressRef.current.x, pressRef.current.y);
      }, LONG_PRESS_MS);
    }
    // A fresh touch arms the swipe (and retires the last gesture's swallow).
    swipedRef.current = false;
    if (swipeable) {
      swipeRef.current = {
        baseX: swipeOpen ? -SWIPE_REVEAL_PX : 0,
        startX: t.clientX,
        startY: t.clientY,
        startedAt: performance.now(),
        locked: false,
        x: 0,
      };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (pressRef.current.timer != null) {
      const t = e.touches[0];
      const dx = t.clientX - pressRef.current.x;
      const dy = t.clientY - pressRef.current.y;
      // Any real movement cancels: scrolling is not a menu request.
      if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX)
        clearPress();
    }
    const s = swipeRef.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.startX;
    const dy = t.clientY - s.startY;
    if (!s.locked) {
      // Lock horizontal only when the gesture commits that way — an
      // ambiguous or vertical touch keeps belonging to the scroll.
      if (Math.abs(dx) > SWIPE_LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
        s.locked = true;
        swipedRef.current = true;
        clearPress(); // a swipe is not a menu request
        setSwiping(true);
      } else {
        return;
      }
    }
    const raw = s.baseX + dx;
    const resisted =
      raw < -SWIPE_REVEAL_PX
        ? -SWIPE_REVEAL_PX + (raw + SWIPE_REVEAL_PX) * 0.25
        : raw > 0
          ? raw * 0.25
          : raw;
    const x = Math.max(
      -SWIPE_REVEAL_PX - SWIPE_OVERPULL_PX,
      Math.min(SWIPE_OVERPULL_PX, resisted),
    );
    s.x = x;
    setSwipeX(x);
  };

  const onTouchEnd = () => {
    clearPress();
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || !s.locked) return;
    setSwiping(false);
    const vel = (s.x - s.baseX) / Math.max(performance.now() - s.startedAt, 1);
    const open =
      s.x <= -SWIPE_REVEAL_PX * SWIPE_OPEN_RATIO || vel < -SWIPE_FLICK_PX_MS;
    setSwipeX(open ? -SWIPE_REVEAL_PX : 0);
    if (open !== swipeOpen) onSwipeOpenChange?.(open);
  };

  const classes = [
    "trackrow",
    `trackrow--${variant}`,
    isCurrent ? "trackrow--playing" : "",
    extraClassName ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const row = (
    <div
      ref={contentRef}
      className={classes}
      style={style}
      role="row"
      onClick={() => {
        // Idempotent play (§23): never toggles — a second click (the tail of
        // a double-click, a restless re-click) must not pause. The click a
        // long-press or swipe leaves behind is swallowed too, and a tap on
        // a revealed row closes it instead of playing.
        if (pressRef.current.fired) {
          pressRef.current.fired = false;
          return;
        }
        if (swipedRef.current) {
          swipedRef.current = false;
          return;
        }
        if (swipeOpen) {
          onSwipeOpenChange?.(false);
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
        {/* The playing marker (§17.7 grammar, shared with the queue drawer):
            accent bars replace the number, frozen while paused; hover swaps
            them for the play/pause glyph below. */}
        {isCurrent && (
          <span className={`trackrow__eq eq${isPlaying ? "" : " eq--paused"}`}>
            <span />
            <span />
            <span />
          </span>
        )}
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

  // Non-playlist rows keep the bare markup (the virtual table positions it).
  if (!swipeable) return row;

  return (
    <div
      className={[
        "trackrowwrap",
        swipeOpen ? "trackrowwrap--open" : "",
        swiping ? "trackrowwrap--dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
    >
      {/* The action lives behind the content; the row slides left over it. */}
      <span className="trackrow__swipeaction">
        <button
          type="button"
          className="trackrow__swipedelete"
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.(track);
          }}
        >
          Remove
        </button>
      </span>
      {row}
    </div>
  );
}
