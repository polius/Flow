/* Artwork cropped to a circle, or a monogram when the artist has no cover
   (or the cover is broken; the img element's error is a designed state,
   not a glyph). Callers pass the effective artwork id: the user-set
   portrait (`cover_artwork_id`) when present, else the latest album's
   cover. */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { artworkUrl } from "../lib/artwork";

export function ArtistPortrait({
  artworkId,
  name,
}: {
  artworkId: number | null | undefined;
  name: string;
}): ReactNode {
  // The failure belongs to one artwork id, like <Artwork>: a new portrait
  // gets its own chance.
  const [failedId, setFailedId] = useState<number | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [renderedPx, setRenderedPx] = useState<number | null>(null);

  // Portraits are sized by CSS (grid tiles, the artist header): measure
  // once before paint so the request asks for the size actually shown.
  useLayoutEffect(() => {
    if (artworkId == null) return;
    const width = imgRef.current?.getBoundingClientRect().width ?? 0;
    setRenderedPx(width > 0 ? width : 256);
  }, [artworkId]);

  if (artworkId == null || failedId === artworkId) {
    return (
      <span className="artistcard__monogram" aria-hidden="true">
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    <img
      ref={imgRef}
      className="artistcard__img"
      src={renderedPx != null ? artworkUrl(artworkId, renderedPx) : undefined}
      alt=""
      loading="lazy"
      onError={() => setFailedId(artworkId)}
    />
  );
}
