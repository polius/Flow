/* Sized artwork URLs. The server resizes covers into a few fixed sizes
   (`/api/artwork/{id}?s=…`, cached on disk); a 38px queue thumbnail
   no longer downloads a 3000px original. Anything bigger than the largest
   size asks for the original. */

/** The sizes the server renders (it snaps any other value up). */
export const ARTWORK_SIZES = [64, 96, 128, 256, 512] as const;

/** The smallest server size covering `cssPx` at the screen's density, or
    null when only the original is sharp enough. */
export function artworkSize(cssPx: number, dpr?: number): number | null {
  const density =
    dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const need = Math.ceil(cssPx * density);
  return ARTWORK_SIZES.find((s) => s >= need) ?? null;
}

/** The URL for artwork `id` rendered `cssPx` wide (the original when no
    size is given or none is big enough). */
export function artworkUrl(id: number, cssPx?: number, dpr?: number): string {
  const s = cssPx != null && cssPx > 0 ? artworkSize(cssPx, dpr) : null;
  return s != null ? `/api/artwork/${id}?s=${s}` : `/api/artwork/${id}`;
}
