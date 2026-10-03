/* The artist portrait (§9.1): artwork cropped to a circle — the Apple-
   Music artist-tab grammar — or a monogram when the artist has no cover
   (or the cover is broken; demo libraries happen; the img element's
   error is a designed state, not a glyph). Callers pass the effective
   artwork id: the user-set portrait (`cover_artwork_id`) when present,
   else the latest album's cover. */

import { useState, type ReactNode } from "react";

export function ArtistPortrait({
  artworkId,
  name,
}: {
  artworkId: number | null | undefined;
  name: string;
}): ReactNode {
  const [failed, setFailed] = useState(false);
  if (artworkId == null || failed) {
    return (
      <span className="artistcard__monogram" aria-hidden="true">
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="artistcard__img"
      src={`/api/artwork/${artworkId}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
