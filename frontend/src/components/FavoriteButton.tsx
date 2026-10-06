/* The favorite toggle for the playing surfaces. One control, two drawings
   of the same heart:

   Bar (default): the ring is part of the drawing — circle and heart on
   one stroke, one ink, no UI box (nothing in the bar wears chrome, and a
   drawn ring reads as a button the way a circled-plus does). Loved
   floods the ring solid with the heart knocked out — the play button's
   own filled-circle weight, the state payoff as loud as the transport's.

   Stage (circled): the bare heart inside a hairline circle — the filing
   pill's outlined sibling; loved releases the border into the soft
   active fill.

   Both toggle through the same two-layer crossfade (the play/pause
   glyph's grammar), driven by the shared mutation — optimistic, the
   queue patched in place, removal undoable. The hover title is the
   control's sentence: it names what the tap will do, in the state the
   tap will leave behind. */

import { useToggleFavorite } from "../api/mutations";
import type { Track } from "../api/types";
import {
  IconHeart,
  IconHeartCircle,
  IconHeartCircleFill,
  IconHeartFill,
} from "./icons";
import "../styles/editing.css";

export function FavoriteButton({
  track,
  size = 22,
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
  const Outline = circled ? IconHeart : IconHeartCircle;
  const Fill = circled ? IconHeartFill : IconHeartCircleFill;
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
          <Outline size={size} />
        </span>
        <span className="favbtn__fill">
          <Fill size={size} />
        </span>
      </span>
    </button>
  );
}
