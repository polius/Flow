/* The Organize grid (§22): windowed rows over the full (filtered) library,
   a sticky column header, and a keyboard cursor.

   Scroller note (§17.2 revision): the shell canvas is the app's scroll
   container (AppShell), so this uses an element virtualizer bound to
   .shell__canvas — the pattern the queue drawer uses for its list — not a
   window virtualizer. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Track } from "../api/types";
import { IconCheck, IconChevronDown, IconMinus } from "./icons";
import { OrganizeRow, ROW_HEIGHT, type RowMods } from "./OrganizeRow";

const OVERSCAN = 12;
/** Start the next page this many rows before the loaded end runs out. */
const PREFETCH_ROWS = 200;

export type SelectAllState = "all" | "none" | "some";

interface OrganizeGridProps {
  tracks: Track[];
  checked: (track: Track) => boolean;
  selectAllState: SelectAllState;
  currentId: number | null;
  compact: boolean;
  /** Keyboard cursor row (explicitly focused grid). */
  cursorIndex: number | null;
  /** Track id whose title editor opens (grid Enter). */
  editTrackId: number | null;
  /** Current column sort (URL state owned by OrganizeView). */
  sort: string;
  dir: "asc" | "desc";
  onSort: (key: string, dir: "asc" | "desc") => void;
  onNearEnd: () => void;
  onToggleAll: () => void;
  onToggleRow: (track: Track, index: number, mods: RowMods) => void;
  onCursorMove: (index: number) => void;
  onCursorToggle: () => void;
  onCursorEdit: () => void;
  onOpenInfo: (track: Track) => void;
  onCommitTitle: (track: Track, title: string) => void;
  onCommitArtist: (track: Track, artist: string) => void;
  onCommitAlbum: (track: Track, album: string) => void;
  onCommitTrackNo: (track: Track, value: number | null) => void;
}

const isInteractiveTarget = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  // §16.3's guard: native activation and text editing come first.
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.tagName === "BUTTON" ||
    el.tagName === "A" ||
    el.isContentEditable
  );
};

export function OrganizeGrid({
  tracks,
  checked,
  selectAllState,
  currentId,
  compact,
  cursorIndex,
  editTrackId,
  sort,
  dir,
  onSort,
  onNearEnd,
  onToggleAll,
  onToggleRow,
  onCursorMove,
  onCursorToggle,
  onCursorEdit,
  onOpenInfo,
  onCommitTitle,
  onCommitArtist,
  onCommitAlbum,
  onCommitTrackNo,
}: OrganizeGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  // The grid itself never scrolls — the shell canvas does (§18). Binding the
  // virtualizer to the canvas keeps windowing honest inside the shared
  // scroll container.
  useLayoutEffect(() => {
    const el = containerRef.current?.closest<HTMLElement>(".shell__canvas");
    setScrollEl(el ?? null);
  }, []);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const endIndex = virtualizer.range?.endIndex ?? -1;
  useEffect(() => {
    if (endIndex >= 0 && endIndex >= tracks.length - PREFETCH_ROWS) onNearEnd();
  }, [endIndex, tracks.length, onNearEnd]);

  // The cursor stays visible without yanking the list mid-read.
  useEffect(() => {
    if (cursorIndex == null || cursorIndex < 0 || cursorIndex >= tracks.length) return;
    virtualizer.scrollToIndex(cursorIndex, { align: "auto" });
  }, [cursorIndex, virtualizer, tracks.length]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isInteractiveTarget(e.target)) return;
      const last = tracks.length - 1;
      const cursor = cursorIndex ?? -1;
      const move = (next: number) => {
        e.preventDefault();
        onCursorMove(Math.max(0, Math.min(last, next)));
      };
      switch (e.key) {
        case "ArrowDown":
          move(cursor + 1);
          break;
        case "ArrowUp":
          move(cursor <= 0 ? 0 : cursor - 1);
          break;
        case "PageDown":
          move(cursor + 20);
          break;
        case "PageUp":
          move(cursor - 20);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(last);
          break;
        case " ":
          if (cursor >= 0) {
            e.preventDefault();
            onCursorToggle();
          }
          break;
        case "a":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onToggleAll();
          }
          break;
        case "Enter":
          if (cursor >= 0) {
            e.preventDefault();
            onCursorEdit();
          }
          break;
      }
    },
    [tracks.length, cursorIndex, onCursorMove, onCursorToggle, onCursorEdit, onToggleAll],
  );

  // Column sort (Finder grammar): click sorts, click again flips. The
  // № column restores the curate order — the grid's native grouping.
  const sortClick = (key: string) => {
    if (key === "curate") {
      onSort("curate", "asc");
      return;
    }
    if (sort === key) onSort(key, dir === "asc" ? "desc" : "asc");
    else onSort(key, "asc");
  };

  const headerArrow = (key: string) =>
    sort === key ? (
      <IconChevronDown
        size={10}
        className={`orghead__arrow${dir === "asc" ? " orghead__arrow--asc" : ""}`}
      />
    ) : null;

  const headerButton = (key: string, label: string, className?: string) => (
    <button
      type="button"
      role="columnheader"
      aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`orghead__label orghead__sort${className ? ` ${className}` : ""}`}
      onClick={() => sortClick(key)}
      title={
        sort === key && key !== "curate"
          ? `Sorted by ${label} — click to reverse`
          : `Sort by ${label}`
      }
    >
      {label}
      {headerArrow(key)}
    </button>
  );

  return (
    <div
      ref={containerRef}
      className="orggrid"
      role="grid"
      aria-label="Library tracks"
      aria-rowcount={tracks.length}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="orghead" role="row">
        <span className="orgrow__check orghead__check" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            role="checkbox"
            aria-checked={selectAllState === "all" ? true : selectAllState === "some" ? "mixed" : false}
            aria-label="Select all matching tracks"
            className={`orgbox${selectAllState !== "none" ? " orgbox--on" : ""}`}
            onClick={onToggleAll}
          >
            {selectAllState === "all" && <IconCheck size={11} />}
            {selectAllState === "some" && <IconMinus size={11} />}
          </button>
        </span>
        <span
          className="orghead__label orghead__no orghead__sort"
          role="columnheader"
          aria-sort={sort === "track_no" ? (dir === "asc" ? "ascending" : "descending") : "none"}
        >
          <button
            type="button"
            className="orghead__nobtn"
            onClick={() => sortClick("track_no")}
            title="Sort by track number — or reset to the curated order"
          >
            №
            {sort === "track_no" && headerArrow("track_no")}
          </button>
        </span>
        {headerButton("title", "Title")}
        {headerButton("artist", "Artist")}
        {headerButton("album", "Album")}
        <span className="orghead__info" aria-hidden="true" />
      </div>
      <div className="orggrid__body" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const track = tracks[item.index];
          if (!track) return null;
          return (
            <OrganizeRow
              key={track.id}
              track={track}
              index={item.index}
              style={{ transform: `translateY(${item.start}px)` }}
              checked={checked(track)}
              isCursor={cursorIndex === item.index}
              isCurrent={currentId === track.id}
              compact={compact}
              editTitle={editTrackId === track.id}
              onToggle={onToggleRow}
              onOpenInfo={onOpenInfo}
              onCommitTitle={onCommitTitle}
              onCommitArtist={onCommitArtist}
              onCommitAlbum={onCommitAlbum}
              onCommitTrackNo={onCommitTrackNo}
            />
          );
        })}
      </div>
    </div>
  );
}
