/* Blurred-artwork ambience: a scaled, heavily blurred cover wash behind
   album detail and Now Playing — one shared treatment. Renders nothing
   without artwork: absence of art stays monochrome. */

import { useState } from "react";

import { artworkUrl } from "../lib/artwork";

interface AmbienceProps {
  artworkId?: number | null;
  /** "banner" hugs a view's header and dissolves before the content. */
  variant?: "banner";
}

/** The wash is blurred past recognition: a small render is all it needs. */
const AMBIENCE_PX = 128;

export function Ambience({ artworkId, variant }: AmbienceProps) {
  // Per artwork id: one failed cover must not hide every later one.
  const [failedId, setFailedId] = useState<number | null>(null);

  if (artworkId == null || failedId === artworkId) return null;

  return (
    <div
      className={`ambience${variant ? ` ambience--${variant}` : ""}`}
      aria-hidden="true"
    >
      <img
        className="ambience__img"
        src={artworkUrl(artworkId, AMBIENCE_PX)}
        alt=""
        onError={() => setFailedId(artworkId)}
      />
    </div>
  );
}
