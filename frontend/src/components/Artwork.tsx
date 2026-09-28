/* Artwork with a designed monochrome placeholder (DESIGN.md §8.1 — the
   artwork is the only color; absence of artwork stays monochrome). */

import { useState } from "react";

import { IconMusicNote } from "./icons";

interface ArtworkProps {
  artworkId?: number | null;
  size: number;
  radius?: "s" | "m" | "l";
  className?: string;
}

export function Artwork({ artworkId, size, radius = "s", className }: ArtworkProps) {
  const [failed, setFailed] = useState(false);

  if (artworkId == null || failed) {
    return (
      <div
        className={`artwork artwork--r-${radius}${className ? ` ${className}` : ""}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <IconMusicNote size={Math.max(14, Math.round(size * 0.4))} />
      </div>
    );
  }

  return (
    <img
      className={`artwork artwork--r-${radius}${className ? ` ${className}` : ""}`}
      src={`/api/artwork/${artworkId}`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
