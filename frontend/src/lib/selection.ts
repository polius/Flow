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

export function useTrackSelection(tracks: Track[], playingId?: number | null) {
  const [ids, setIds] = useState<ReadonlySet<number>>(() => new Set());
  const anchorIdRef = useRef<number | null>(null);
  const lastIdRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    setIds(new Set());
    anchorIdRef.current = null;
    lastIdRef.current = null;
  }, []);

  /** Handles a row click. Always consumes it — modifier clicks grow or
      shrink the selection around the clicked row; a plain click just
      dissolves any live selection. */
  const onRowClick = useCallback(
    (track: Track, index: number, e: SelectClick): boolean => {
      const mod = e.metaKey || e.ctrlKey || e.altKey;
      const next = new Set(ids);
      if (mod) {
        // The playing track is already in a fresh selection: the first
        // modifier click files the group (playing + clicked), not the
        // clicked row alone. Clicking the playing track itself selects
        // it like any other row.
        if (
          next.size === 0 &&
          playingId != null &&
          track.id !== playingId &&
          tracks.some((t) => t.id === playingId)
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
            ? tracks.findIndex((t) => t.id === anchorIdRef.current)
            : -1;
        const from = anchorIndex >= 0 ? anchorIndex : index;
        const [lo, hi] = from <= index ? [from, index] : [index, from];
        next.clear();
        for (let i = lo; i <= hi; i++) next.add(tracks[i].id);
        lastIdRef.current = track.id;
      } else {
        // Plain click: never selects — a live selection dissolves and the
        // pill hides with it; with none live there is nothing to do.
        // Building a selection is the modifiers' job.
        if (ids.size > 0) clear();
        return true;
      }
      setIds(next);
      return true;
    },
    [ids, tracks, clear, playingId],
  );

  /** The index of the last-selected row in the current list — the row
      Enter plays while a selection is live (null when it no longer
      resolves, e.g. the row was removed; Enter then falls back to the
      cursor grammar). */
  const lastIndex = useCallback((): number | null => {
    if (lastIdRef.current == null || ids.size === 0) return null;
    const i = tracks.findIndex((t) => t.id === lastIdRef.current);
    return i >= 0 ? i : null;
  }, [tracks, ids]);

  const selectedTracks = useMemo(
    () => tracks.filter((t) => ids.has(t.id)),
    [tracks, ids],
  );

  // Esc clears the selection — but only when no surface owns the
  // keyboard: a context menu, the picker, Get Info, or either takeover
  // clears nothing and closes itself first.
  const count = ids.size;
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

  return { ids, count, selectedTracks, onRowClick, lastIndex, clear };
}
