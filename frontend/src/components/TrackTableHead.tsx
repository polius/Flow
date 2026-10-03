/* Sticky column header for the track tables. It mirrors the grid of the
   rows beneath it — same template, same gap, same breakpoints — so the
   columns line up exactly. Detail views render the same head statically:
   their order is curated, so the header aligns the columns without
   promising a sort it can't do. */

import type { CSSProperties } from "react";

import { IconChevronDown } from "./icons";
import type { TrackVariant } from "./TrackRow";

export type TrackSortKey = "title" | "artist" | "album" | "duration";

const COLUMNS: { key: TrackSortKey; label: string; className: string }[] = [
  { key: "title", label: "Title", className: "trackhead__title" },
  { key: "artist", label: "Artist", className: "trackhead__secondary" },
  { key: "album", label: "Album", className: "trackhead__secondary" },
];

const byKey = Object.fromEntries(COLUMNS.map((c) => [c.key, c])) as Record<
  TrackSortKey,
  (typeof COLUMNS)[number]
>;

/** Which labeled columns each row variant carries (mirrors TrackRow). */
const VARIANT_COLUMNS: Record<TrackVariant, TrackSortKey[]> = {
  album: ["title"],
  artist: ["title", "artist"],
  all: ["title", "artist", "album"],
  playlist: ["title", "artist", "album"],
};

interface TrackTableHeadProps {
  /** Column set + trailing slots, mirroring the TrackRow variant below. */
  variant?: TrackVariant;
  sort?: string;
  dir?: "asc" | "desc";
  /** Header of a sheet scrolls its own canvas — sticky offset stays 0. */
  style?: CSSProperties;
  /** Absent → a static head (detail views); present → sortable buttons. */
  onSort?: (key: TrackSortKey, dir: "asc" | "desc") => void;
}

export function TrackTableHead({
  variant = "all",
  sort,
  dir,
  style,
  onSort,
}: TrackTableHeadProps) {
  const arrow = (key: string) =>
    sort === key ? (
      <IconChevronDown
        size={11}
        className={`trackhead__arrow${dir === "asc" ? " trackhead__arrow--asc" : ""}`}
      />
    ) : null;

  const click = (key: TrackSortKey) => {
    if (!onSort) return;
    if (key === sort) onSort(key, dir === "asc" ? "desc" : "asc");
    else onSort(key, "asc");
  };

  return (
    <div className={`trackhead trackhead--${variant}`} role="row" style={style}>
      <span className="trackhead__index" aria-hidden="true">
        #
      </span>
      {VARIANT_COLUMNS[variant].map((key) => {
        const { label, className } = byKey[key];
        return onSort ? (
          <button
            key={key}
            type="button"
            role="columnheader"
            aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"}
            className={`trackhead__sort ${className}`}
            onClick={() => click(key)}
          >
            {label}
            {arrow(key)}
          </button>
        ) : (
          <span key={key} role="columnheader" className={`trackhead__sort ${className}`}>
            {label}
          </span>
        );
      })}
      <span className="trackhead__time" aria-hidden="true">
        Time
      </span>
      <span className="trackhead__heart" aria-hidden="true" />
      {/* Playlist rows carry a second hover slot (remove); the head keeps
          the column honest with an empty span of its own. Own class so the
          touch sweep can fold it away with the row's slot. */}
      {variant === "playlist" && <span className="trackhead__remove" aria-hidden="true" />}
    </div>
  );
}
