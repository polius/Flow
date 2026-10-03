/* Blurred-artwork ambience: a scaled, heavily blurred cover wash behind
   album detail and Now Playing — one shared treatment. Renders nothing
   without artwork: absence of art stays monochrome. */

import { useState } from "react";

interface AmbienceProps {
  artworkId?: number | null;
  /** "banner" hugs a view's header and dissolves before the content. */
  variant?: "banner";
}

export function Ambience({ artworkId, variant }: AmbienceProps) {
  const [failed, setFailed] = useState(false);

  if (artworkId == null || failed) return null;

  return (
    <div
      className={`ambience${variant ? ` ambience--${variant}` : ""}`}
      aria-hidden="true"
    >
      <img
        className="ambience__img"
        src={`/api/artwork/${artworkId}`}
        alt=""
        onError={() => setFailed(true)}
      />
    </div>
  );
}
