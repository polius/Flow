/* Multi-select for the listening tables: modifier clicks build the
   selection — Cmd/Ctrl/Alt toggles a row, Shift takes the contiguous
   range from the anchor — and a fresh selection counts the playing
   track as already in. Plain clicks never select: the title plays, and
   any live selection just dissolves. Selection is identified by TRACK
   ID, so a reorder or removal under a live selection moves with the
   rows instead of re-pointing at different ones. No chrome exists until
   a selection does; the long-press menu stays the touch path for the
   other verbs. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Track } from "../api/types";
import { isTextEditingTarget } from "./shortcuts";
import { useUiStore } from "../stores/ui";

export interface SelectClick {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface RowRange {
  lo: number;
  hi: number;
}

function idsIn(tracks: readonly (Track | undefined)[], range: RowRange): Set<number> {
  const out = new Set<number>();
  for (let i = range.lo; i <= range.hi; i++) {
    const id = tracks[i]?.id;
    if (id != null) out.add(id);
  }
  return out;
}

function hasHole(tracks: readonly (Track | undefined)[], range: RowRange): boolean {
  for (let i = range.lo; i <= range.hi; i++) if (tracks[i] == null) return true;
  return false;
}

/** `tracks` may hold empty slots: a paged list has one per row, filled as
    its page arrives. A shift-click range over empty slots asks `ensure`
    for their pages and is `loading` until they arrive: it counts as the
    whole range, and the bar holds its verbs, so nothing acts on a part. */
export function useTrackSelection(
  tracks: readonly (Track | undefined)[],
  playingId?: number | null,
  ensure?: (start: number, end: number) => void,
) {
  const [ids, setIds] = useState<ReadonlySet<number>>(() => new Set());
  // A shift range still waiting on rows, by index. Once every row in it
  // has arrived it becomes ids, which survive reorders.
  const [range, setRange] = useState<RowRange | null>(null);
  const anchorIdRef = useRef<number | null>(null);
  const lastIdRef = useRef<number | null>(null);

  const loading = range != null && hasHole(tracks, range);
  if (range != null && !loading) {
    setIds(idsIn(tracks, range));
    setRange(null);
  }
  const current = useMemo(
    () => (range != null ? idsIn(tracks, range) : ids),
    [range, tracks, ids],
  );

  const clear = useCallback(() => {
    setIds(new Set());
    setRange(null);
    anchorIdRef.current = null;
    lastIdRef.current = null;
  }, []);

  /** Handles a row click. Always consumes it — modifier clicks grow or
      shrink the selection around the clicked row; a plain click just
      dissolves any live selection. */
  const onRowClick = useCallback(
    (track: Track, index: number, e: SelectClick): boolean => {
      const mod = e.metaKey || e.ctrlKey || e.altKey;
      const next = new Set(current);
      setRange(null);
      if (mod) {
        // The playing track is already in a fresh selection: the first
        // modifier click files the group (playing + clicked), not the
        // clicked row alone. Clicking the playing track itself selects
        // it like any other row.
        if (
          next.size === 0 &&
          playingId != null &&
          track.id !== playingId &&
          tracks.some((t) => t?.id === playingId)
        ) {
          next.add(playingId);
        }
        if (next.has(track.id)) {
          next.delete(track.id);
          if (lastIdRef.current === track.id) lastIdRef.current = null;
        } else {
          next.add(track.id);
          lastIdRef.current = track.id;
        }
        anchorIdRef.current = track.id;
      } else if (e.shiftKey) {
        // Shift: the contiguous range from the anchor — replaced whole,
        // the Finder default (a lone shift-click selects just that row).
        const anchorIndex =
          anchorIdRef.current != null
            ? tracks.findIndex((t) => t?.id === anchorIdRef.current)
            : -1;
        const from = anchorIndex >= 0 ? anchorIndex : index;
        const [lo, hi] = from <= index ? [from, index] : [index, from];
        lastIdRef.current = track.id;
        if (hasHole(tracks, { lo, hi })) {
          // Rows a jump skipped: fetch them, and select the range as it fills.
          ensure?.(lo, hi);
          setIds(new Set());
          setRange({ lo, hi });
          return true;
        }
        next.clear();
        for (const id of idsIn(tracks, { lo, hi })) next.add(id);
      } else {
        // Plain click: never selects — a live selection dissolves and the
        // pill hides with it; with none live there is nothing to do.
        // Building a selection is the modifiers' job.
        if (current.size > 0 || range != null) clear();
        return true;
      }
      setIds(next);
      return true;
    },
    [current, range, tracks, clear, playingId, ensure],
  );

  /** The index of the last-selected row in the current list — the row
      Enter plays while a selection is live (null when it no longer
      resolves, e.g. the row was removed; Enter then falls back to the
      cursor grammar). */
  const lastIndex = useCallback((): number | null => {
    if (lastIdRef.current == null || current.size === 0) return null;
    const i = tracks.findIndex((t) => t?.id === lastIdRef.current);
    return i >= 0 ? i : null;
  }, [tracks, current]);

  const selectedTracks = useMemo(
    () => tracks.filter((t): t is Track => t != null && current.has(t.id)),
    [tracks, current],
  );

  // Esc clears the selection — but only when no surface owns the
  // keyboard: a context menu, the picker, Get Info, or either takeover
  // clears nothing and closes itself first.
  const count = range != null ? range.hi - range.lo + 1 : current.size;
  useEffect(() => {
    if (count === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isTextEditingTarget(document.activeElement)) return;
      const ui = useUiStore.getState();
      if (
        ui.contextMenuOpen ||
        ui.pickerOpen ||
        ui.getInfoTrackId != null ||
        ui.nowPlayingOpen ||
        ui.organizeOpen
      )
        return;
      clear();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [count, clear]);

  return { ids: current, count, loading, selectedTracks, onRowClick, lastIndex, clear };
}
