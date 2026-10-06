/* The favorite toggle for the playing surfaces — the bottom bar (after the
   song name) and the Now Playing stage (beside the filing pill). A real
   control, not a floating glyph: a hairline circle — Spotify's mini-player
   "+" reads as a button, and so does this — holding the app's heart.
   Loved turns the circle ON with the transport's own active language: the
   soft active fill under a full-ink filled heart, border released. The
   outline and fill are the same path on two layers, so toggling reads as
   the heart filling in, not two icons swapping. Driven by the shared
   mutation — optimistic, the queue patched in place, removal undoable.
   The hover title is the control's sentence: it names what the tap will
   do, in the state the tap will leave behind. */

import { useToggleFavorite } from "../api/mutations";
import type { Track } from "../api/types";
import { IconHeart, IconHeartFill } from "./icons";
import "../styles/editing.css";

export function FavoriteButton({
  track,
  size = 14,
  className,
}: {
  track: Track;
  size?: number;
  className?: string;
}) {
  const toggleFavorite = useToggleFavorite();
  const favorite = track.favorite === true;
  return (
    <button
      type="button"
      className={`favbtn${favorite ? " favbtn--on" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={favorite}
      aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"}
      title={favorite ? "Remove from Favorites" : "Add to Favorites"}
      onClick={() => toggleFavorite(track)}
    >
      {/* The glyph stack: outline retires as the fill settles in — the
          play/pause crossfade's exact grammar (see player.css). */}
      <span
        className="favbtn__glyph"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <span className="favbtn__outline">
          <IconHeart size={size} />
        </span>
        <span className="favbtn__fill">
          <IconHeartFill size={size} />
        </span>
      </span>
    </button>
  );
}
