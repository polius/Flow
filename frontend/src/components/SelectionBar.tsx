/* The listening selection bar (§4.1, Review 2): the Organize BulkBar's
   grammar (§22) repurposed for curation-on-listening — Add to Playlist /
   Add to Queue / Favorite. It exists only while a selection does (no chrome
   until then, §8.0.3), floats above the player bar like its Organize
   sibling, and its verbs reuse the app's own paths rather than inventing:
   the §30.2 destination dialog, the §1.2 queue append (whose arrival toast
   the store fires), and the §26 favorite undo grammar. */

import { IconClose } from "./icons";
import "../styles/organize.css";

interface SelectionBarProps {
  count: number;
  /** Whether every selected track is already favorited — flips the bar's
      one toggle verb between Favorite and Unfavorite. */
  allFavorite: boolean;
  onAddToPlaylist: () => void;
  onAddToQueue: () => void;
  onToggleFavorite: () => void;
  onClear: () => void;
}

export function SelectionBar({
  count,
  allFavorite,
  onAddToPlaylist,
  onAddToQueue,
  onToggleFavorite,
  onClear,
}: SelectionBarProps) {
  return (
    <div className="orgbar" role="toolbar" aria-label="Selected tracks">
      <span className="orgbar__count">{count.toLocaleString()} selected</span>
      <span className="orgbar__sep" aria-hidden="true" />
      <button type="button" className="orgbar__action" onClick={onAddToPlaylist}>
        Add to Playlist…
      </button>
      <button type="button" className="orgbar__action" onClick={onAddToQueue}>
        Add to Queue
      </button>
      <button type="button" className="orgbar__action" onClick={onToggleFavorite}>
        {allFavorite ? "Unfavorite" : "Favorite"}
      </button>
      <span className="orgbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="orgbar__quiet"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
