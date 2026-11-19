/* The listening selection bar: the Organize BulkBar's grammar repurposed
   for curation-on-listening — Add to Playlist / Add to Queue / Favorite.
   It exists only while a selection does, floats above the player bar, and
   its verbs reuse the app's own paths (the destination dialog, the store's
   queue append and its arrival toast, the favorite undo). */

import { IconClose } from "./icons";
import "../styles/organize.css";

interface SelectionBarProps {
  count: number;
  /** Rows of the selection are still loading: the verbs wait for them. */
  loading?: boolean;
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
  loading = false,
  allFavorite,
  onAddToPlaylist,
  onAddToQueue,
  onToggleFavorite,
  onClear,
}: SelectionBarProps) {
  return (
    <div className="orgbar" role="toolbar" aria-label="Selected tracks">
      <span className="orgbar__count">
        {loading ? `Selecting ${count.toLocaleString()}…` : `${count.toLocaleString()} selected`}
      </span>
      <span className="orgbar__sep" aria-hidden="true" />
      <button type="button" className="orgbar__action" onClick={onAddToPlaylist} disabled={loading}>
        Add to Playlist…
      </button>
      <button type="button" className="orgbar__action" onClick={onAddToQueue} disabled={loading}>
        Add to Queue
      </button>
      <button type="button" className="orgbar__action" onClick={onToggleFavorite} disabled={loading}>
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
