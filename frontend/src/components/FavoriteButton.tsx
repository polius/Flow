/* The favorite toggle for the playing surfaces — the bottom bar (after the
   song name) and the Now Playing stage (beside the filing pill). One
   control, two dress codes: on the stage it is a hairline circle, the
   filing pill's outlined sibling — the glyph is half its circle there,
   so the ~6px inset keeps the ring from crowding the heart; in the bar
   it is a bare glyph, because nothing in the bar wears a border — a
   resting ring there reads as a form control, not a player control.
   Both speak the same states: the outline and the fill are the same
   path on two layers, so toggling reads as the heart filling in, not
   two icons swapping; loved wears the soft active fill. Driven by the
   shared mutation — optimistic, the queue patched in place, removal
   undoable. The hover title is the control's sentence: it names what
   the tap will do, in the state the tap will leave behind. */

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

