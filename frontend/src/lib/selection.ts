/* Marquee multi-select for the listening tables (§4.1, Review 2): the one
   §23 decision the review re-litigated, decided with the owner (2026-10-01)
   as option (b) — Cmd/Shift-click selects rows and a floating quiet bar
   offers Add to Playlist / Add to Queue / Favorite (the Organize BulkBar's
   §22 grammar, minus the editing).

   2026-10-03, the review's follow-up — the grammar moves to the standard
   select-on-click model the review's report asked for: a plain click now
   SELECTS the row (replacing any live selection), and playback leaves the
   click entirely — the row's Play button (and the keyboard cursor's Enter)
   are the only ways to start a track from a table. Modifier-clicks select
   more:

   The contract is "transient and listening-safe":
   - a plain click selects just that row — Finder/Explorer's single-select;
   - Cmd/Ctrl/Alt-click toggles one row into/out of the selection (2026-10-03:
     Alt joins the set — the same grammar, one more key people already reach
     for); Shift-click selects the contiguous range from the anchor (the
     last selection click), Finder-style;
   - selection is identified by TRACK ID, so a playlist reorder or removal
     under a live selection moves with the rows instead of silently
     re-pointing at different ones (duplicates select together — it reads
     as "this track", which is what the verbs act on);
   - Enter on a selection plays the last-selected row (in the table's whole
     context, §29); Esc clears it; no other behavior changes.

   No chrome exists until a selection does (§8.0.3). Touch now selects too —
   a tap is the plain click (single-select); the long-press menu stays the
   touch path for playback and the other verbs. */

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

export function useTrackSelection(tracks: Track[]) {
  const [ids, setIds] = useState<ReadonlySet<number>>(() => new Set());
  const anchorIdRef = useRef<number | null>(null);
  const lastIdRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    setIds(new Set());
    anchorIdRef.current = null;
    lastIdRef.current = null;
  }, []);

  /** Handles a row click. Always consumes it — the row never plays from a
      click (the Play button and the keyboard own playback now); a plain
      click selects just that row, a modifier-click grows or shrinks the
      selection around it. */
  const onRowClick = useCallback(
    (track: Track, index: number, e: SelectClick): boolean => {
      const mod = e.metaKey || e.ctrlKey || e.altKey;
      const next = new Set(ids);
      if (mod) {
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
        // Plain click: single-select, replaced whole (the standard grammar
        // the click-to-play rows superseded). Re-clicking the lone selected
        // row keeps it — clearing is Esc and the bar's ×, not a click trap.
        next.clear();
        next.add(track.id);
        anchorIdRef.current = track.id;
        lastIdRef.current = track.id;
      }
      setIds(next);
      return true;
    },
    [ids, tracks, clear],
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

  // Esc clears the selection — but only when no surface owns the keyboard
  // (the §16.4/§29 precedence, applied locally): a context menu, the picker,
  // Get Info, or either takeover clears nothing and closes itself first.
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
