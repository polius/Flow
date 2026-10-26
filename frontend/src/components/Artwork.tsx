/* The monochrome placeholder is deliberate: absence of artwork stays
   colorless — the artwork is the only color. */

import { useLayoutEffect, useRef, useState } from "react";

import { artworkUrl } from "../lib/artwork";
import { IconMusicNote } from "./icons";

interface ArtworkProps {
  artworkId?: number | null;
  size: number;
  radius?: "s" | "m" | "l";
  className?: string;
}

/** At or above this `size`, art may be stretched by CSS (grids, the Now
    Playing stage): its rendered width is measured once before the image
    is requested. Row thumbnails below it render exactly at `size`. */
const MEASURE_FROM = 64;

export function Artwork({ artworkId, size, radius = "s", className }: ArtworkProps) {
  // The failure belongs to one artwork id: the next track's cover gets
  // its own chance (one broken cover once blanked every later one).
  const [failedId, setFailedId] = useState<number | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const measure = size >= MEASURE_FROM;
  const [renderedPx, setRenderedPx] = useState<number | null>(measure ? null : size);

  // Measured before paint, so the image is requested once at the size it
  // actually renders (CSS × devicePixelRatio, snapped server-side).
  useLayoutEffect(() => {
    if (!measure || artworkId == null) return;
    const width = imgRef.current?.getBoundingClientRect().width ?? 0;
    setRenderedPx(width > 0 ? Math.max(width, size) : size);
  }, [measure, artworkId, size]);

  if (artworkId == null || failedId === artworkId) {
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
      ref={imgRef}
      className={`artwork artwork--r-${radius}${className ? ` ${className}` : ""}`}
      src={renderedPx != null ? artworkUrl(artworkId, renderedPx) : undefined}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setFailedId(artworkId)}
    />
  );
}
