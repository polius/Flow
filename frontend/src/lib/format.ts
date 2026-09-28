/* Small formatting helpers shared across views. */

const numberFormat = new Intl.NumberFormat();

export function fmtCount(n: number): string {
  return numberFormat.format(n);
}

/** "Scanning… 342/1,204" body — omit counts when the total isn't known yet. */
export function scanProgressLabel(current: number, total: number): string {
  if (total === 0) return "Scanning…";
  return `Scanning… ${fmtCount(current)}/${fmtCount(total)}`;
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
