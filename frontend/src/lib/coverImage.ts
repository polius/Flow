/* Cover upload preparation, shared by every CoverEdit (playlist, album,
   artist). Files that already fit the server's contract pass through
   untouched; oversized images (a phone's photo roll routinely produces
   4–12 MB JPEGs) are decoded, downscaled to a sane artwork edge, and
   re-encoded as JPEG — a 220px header never needed the original pixels,
   and the proxy hop between the browser and uvicorn no longer has to
   carry them either. */

/** Images at or under this size upload as-is — no quality spent. */
const PASS_THROUGH_BYTES = 4 * 1024 * 1024;
/** The longest edge a re-encoded cover may have. */
const MAX_EDGE = 2000;
/** JPEG quality for the re-encode: visually lossless for artwork. */
const JPEG_QUALITY = 0.9;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = url;
  });
}

export async function prepareCoverFile(file: File): Promise<File> {
  // Only raster images participate; anything else (or anything small
  // enough) rides along for the server's own validation to judge.
  if (!file.type.startsWith("image/") || file.size <= PASS_THROUGH_BYTES) {
    return file;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest === 0 || !Number.isFinite(longest)) return file;
    const scale = Math.min(1, MAX_EDGE / longest);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // JPEG has no alpha: matte transparent PNGs onto white instead of
    // letting the encoder turn the background black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    // A decode failure is not ours to hide the upload behind: pass the
    // original through and let the server answer with its honest error.
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}
