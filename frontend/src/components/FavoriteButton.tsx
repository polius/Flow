/* The favorite toggle for the playing surfaces — the bottom bar (after the
   song name) and the Now Playing stage (beside the filing pill). One
   control, one grammar: the same outline→fill heart the rows and the
   action menu speak, driven by the same shared mutation — optimistic, the
   queue patched in place, removal undoable. The hover title is the
   control's sentence: it names what the tap will do, in the state the tap
   will leave behind. */

import { useToggleFavorite } from "../api/mutations";
import type { Track } from "../api/types";
import { IconHeart, IconHeartFill } from "./icons";
import "../styles/editing.css";

export function FavoriteButton({
  track,
  size = 15,
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
      {/* The glyph swaps outline→fill; the pop animation rides the class so
          only the gaining direction springs — removal is a quiet swap. */}
      <span className="favbtn__glyph" aria-hidden="true">
        {favorite ? <IconHeartFill size={size} /> : <IconHeart size={size} />}
      </span>
    </button>
  );
}
