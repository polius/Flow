/* The favorite toggle for the playing surfaces — the bottom bar (after the
   song name) and the Now Playing stage (beside the filing pill). One
   control, two dress codes: a hairline circle on the stage, a bare glyph
   in the bar (nothing there wears a border). Both share the glyph
   crossfade — outline and fill are the same path on two layers, so
   toggling reads as the heart filling in, not two icons swapping. */

import { useToggleFavorite } from "../api/mutations";
import type { Track } from "../api/types";
import { IconHeart, IconHeartFill } from "./icons";
import "../styles/editing.css";

export function FavoriteButton({
  track,
  size = 16,
  className,
  circled = false,
}: {
  track: Track;
  size?: number;
  className?: string;
  circled?: boolean;
}) {
  const toggleFavorite = useToggleFavorite();
  const favorite = track.favorite === true;
  return (
    <button
      type="button"
      className={`favbtn${circled ? " favbtn--circled" : ""}${favorite ? " favbtn--on" : ""}${className ? ` ${className}` : ""}`}
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

