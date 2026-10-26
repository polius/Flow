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

  // Rendered inside the table's grid (the `head` prop), as its first row:
  // one columnheader per row cell, so every cell has a name. Sortable
  // columns keep a real <button> INSIDE the columnheader — a button
  // wearing role=columnheader stops being announced as a button.
  return (
    <div
      className={`trackhead trackhead--${variant}`}
      role="row"
      aria-rowindex={1}
      style={style}
    >
      <span className="trackhead__index" role="columnheader">
        <span aria-hidden="true">#</span>
        <span className="sr-only">Number</span>
      </span>
      {VARIANT_COLUMNS[variant].map((key) => {
        const { label, className } = byKey[key];
        return onSort ? (
          <span
            key={key}
            role="columnheader"
            aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"}
            className={`trackhead__cell ${className}`}
          >
            <button type="button" className="trackhead__sort" onClick={() => click(key)}>
              {label}
              {arrow(key)}
            </button>
          </span>
        ) : (
          <span key={key} role="columnheader" className={`trackhead__sort ${className}`}>
            {label}
          </span>
        );
      })}
      <span className="trackhead__time" role="columnheader">
        Time
      </span>
      <span className="trackhead__heart" role="columnheader">
        <span className="sr-only">Favorite</span>
      </span>
      {/* Playlist rows carry a second hover slot (remove); the head keeps
          the column honest with a header of its own. Own class so the
          touch sweep can fold it away with the row's slot. */}
      {variant === "playlist" && (
        <span className="trackhead__remove" role="columnheader">
          <span className="sr-only">Remove</span>
        </span>
      )}
    </div>
  );
}
