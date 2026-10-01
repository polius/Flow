/* Small formatting helpers shared across views. */

const numberFormat = new Intl.NumberFormat();

export function fmtCount(n: number): string {
  return numberFormat.format(n);
}

/** 81.4 → "1:21"; 3841 → "1:04:01"; unknown → "–:––" */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "–:––";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Album header length: "48 min" / "1 hr 12 min" */
export function fmtMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
}

/** "Scanning… 342/1,204" body — omit counts when the total isn't known yet. */
export function scanProgressLabel(current: number, total: number): string {
  if (total === 0) return "Scanning…";
  return `Scanning… ${fmtCount(current)}/${fmtCount(total)}`;
}

/** Library-relative path → file name ("Artist/Album/01 Song.flac" → "01 Song.flac").
    Tolerates a missing path (older API payloads) by rendering nothing. */
export function fmtBasename(path: string | null | undefined): string {
  if (!path) return "";
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function fmtDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
