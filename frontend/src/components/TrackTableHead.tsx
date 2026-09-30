/* Sticky sortable column header for the full-library track tables (Tracks,
   Favorites). It mirrors the `.trackrow--all` grid exactly — same template,
   same gap, same breakpoints — so columns line up with the virtual rows
   beneath it. Click a column to sort; click it again to flip (Finder).
   Sort state lives in the owning view's URL params. */

import type { CSSProperties } from "react";

import { IconChevronDown } from "./icons";

export type TrackSortKey = "title" | "artist" | "album" | "duration";

const COLUMNS: { key: TrackSortKey; label: string; className: string }[] = [
  { key: "title", label: "Title", className: "trackhead__title" },
  { key: "artist", label: "Artist", className: "trackhead__secondary" },
  { key: "album", label: "Album", className: "trackhead__secondary" },
];

interface TrackTableHeadProps {
  sort: string;
  dir: "asc" | "desc";
  /** Header of a sheet scrolls its own canvas — sticky offset stays 0. */
  style?: CSSProperties;
  onSort: (key: TrackSortKey, dir: "asc" | "desc") => void;
}

export function TrackTableHead({ sort, dir, style, onSort }: TrackTableHeadProps) {
  const arrow = (key: string) =>
    sort === key ? (
      <IconChevronDown
        size={11}
        className={`trackhead__arrow${dir === "asc" ? " trackhead__arrow--asc" : ""}`}
      />
    ) : null;

  const click = (key: TrackSortKey) => {
    if (key === sort) onSort(key, dir === "asc" ? "desc" : "asc");
    else onSort(key, "asc");
  };

  return (
    <div className="trackhead" role="row" style={style}>
      <span className="trackhead__index" aria-hidden="true">
        #
      </span>
      {COLUMNS.map(({ key, label, className }) => (
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
      ))}
      <span className="trackhead__time" aria-hidden="true">
        Time
      </span>
      <span className="trackhead__heart" aria-hidden="true" />
    </div>
  );
}
