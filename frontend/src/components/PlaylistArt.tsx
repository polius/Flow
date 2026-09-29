/* Playlist card artwork — the 2×2 mosaic of track covers (§13.10).
   0 tracks → all-monochrome placeholder; 1 → full bleed; 2 → halves;
   3–4 → quadrant grid. Never synthesizes color (§8.1). */

import { Artwork } from "./Artwork";
import { IconPlaylists } from "./icons";
import "../styles/library.css";
import "../styles/editing.css";

interface PlaylistArtProps {
  artworkIds: number[];
  size: number;
  radius?: "s" | "m" | "l";
  className?: string;
}

export function PlaylistArt({ artworkIds, size, radius = "m", className }: PlaylistArtProps) {
  const ids = artworkIds.slice(0, 4);
  const cell = ids.length <= 2 ? size : Math.round(size / 2);
  const shape =
    ids.length === 0
      ? "playlistart--empty"
      : ids.length === 1
        ? "playlistart--one"
        : ids.length === 2
          ? "playlistart--two"
          : "playlistart--four";

  return (
    <div
      className={`playlistart playlistart--r-${radius} ${shape}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {ids.length === 0 ? (
        <span className="playlistart__placeholder">
          <IconPlaylists size={Math.round(size * 0.3)} />
        </span>
      ) : (
        ids.map((id, i) => <Artwork key={`${id}-${i}`} artworkId={id} size={cell} radius="s" />)
      )}
    </div>
  );
}
