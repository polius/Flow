/* The Organize view's selection bar: bulk set (album/artist/genre) with
   suggestions from the existing entities, and a confirm sheet with honest
   arithmetic (count + what gets removed). The apply itself reports through
   the app's undo pill — this component only gathers the change. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import type { Track } from "../api/types";
import { useUiStore } from "../stores/ui";

export type BulkField = "artist" | "album" | "album_artist" | "genre";

interface BulkBarProps {
  count: number;
  filterMode: boolean;
  applying: boolean;
  /** The selected tracks themselves — explicit selections only; empty in
      filter mode (unloaded pages mean consequences stay generic). */
  selectedTracks: Track[];
  onClear: () => void;
  onApply: (changes: {
    artist?: string;
    album?: string;
    album_artist?: string;
    genre?: string;
  }) => void;
}

/** Debounce helper shared by the suggestion inputs. */
function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface ConfirmState {
  field: BulkField;
  value: string;
}

export function BulkBar({ count, filterMode, applying, selectedTracks, onClear, onApply }: BulkBarProps) {
  const [popover, setPopover] = useState<BulkField | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [input, setInput] = useState("");
  const q = useDebounced(input, 150);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const setContextMenuOpen = useUiStore((s) => s.setContextMenuOpen);

  useEffect(() => {
    if (popover == null) return;
    setContextMenuOpen(true);
    inputRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setPopover(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopover(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      setContextMenuOpen(false);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [popover, setContextMenuOpen]);

  // Confirm sheet: registered like a menu so Esc unwinds it first.
  useEffect(() => {
    if (confirm == null) return;
    setContextMenuOpen(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirm(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      setContextMenuOpen(false);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [confirm, setContextMenuOpen]);

  const suggestions = useQuery({
    queryKey: ["suggest", popover, q],
    queryFn: async () => {
      // Normalized shape: the endpoints differ, the popover doesn't care.
      if (popover === "album") {
        const { data } = await api.GET("/api/albums", {
          params: { query: { ...(q ? { q } : {}), limit: 8, sort: "title" } },
        });
        return (data?.items ?? []).map((a) => ({
          id: a.id,
          name: a.title,
          track_count: a.track_count,
        }));
      }
      // Genres: one small list, filtered here — the same vocabulary the
      // Tracks filter menu reads.
      if (popover === "genre") {
        const { data } = await api.GET("/api/genres", {
          params: { query: { limit: 1000 } },
        });
        const needle = q.trim().toLowerCase();
        return (data?.items ?? [])
          .filter((g) => !needle || g.name.toLowerCase().includes(needle))
          .slice(0, 8)
          .map((g) => ({ id: g.id, name: g.name, track_count: g.track_count }));
      }
      // artist + album_artist both resolve artist names.
      const { data } = await api.GET("/api/artists", {
        params: { query: { ...(q ? { q } : {}), limit: 8 } },
      });
      return (data?.items ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        track_count: a.track_count,
      }));
    },
    enabled: popover != null,
    placeholderData: (prev) => prev,
  });

  const matches = suggestions.data ?? [];
  const exactMatch = matches.some((m) => m.name.trim().toLowerCase() === q.trim().toLowerCase());

  const open = (field: BulkField) => {
    setInput("");
    setPopover(field);
  };

  const propose = (value: string) => {
    if (popover == null) return;
    setConfirm({ field: popover, value });
    setPopover(null);
  };

  const confirmTitle = confirm?.value.trim()
    ? `Set ${
        confirm.field === "album"
          ? "album"
          : confirm.field === "album_artist"
            ? "album artist"
            : confirm.field === "genre"
              ? "genre"
              : "artist"
      } to “${confirm.value.trim()}”`
    : `Clear ${
        confirm?.field === "album"
          ? "album"
          : confirm?.field === "album_artist"
            ? "album artist"
            : confirm?.field === "genre"
              ? "genre"
              : "artist"
      }`;

  return (
    <>
      <div className="orgbar" role="toolbar" aria-label="Bulk actions">
        <span className="orgbar__count">
          {count.toLocaleString()} selected
          {filterMode ? " of all matching" : ""}
        </span>
        <span className="orgbar__sep" aria-hidden="true" />
        <button type="button" className="orgbar__action" onClick={() => open("album")}>
          Set Album…
        </button>
        <button type="button" className="orgbar__action" onClick={() => open("artist")}>
          Set Artist…
        </button>
        <button
          type="button"
          className="orgbar__action"
          onClick={() => open("album_artist")}
          title="Resolve a compilation: one album artist for every selected track"
        >
          Set Album Artist…
        </button>
        <button
          type="button"
          className="orgbar__action"
          onClick={() => open("genre")}
          title="Set the genre the Tracks filter groups these tracks by"
        >
          Set Genre…
        </button>
        <span className="orgbar__sep" aria-hidden="true" />
        <button type="button" className="orgbar__quiet" onClick={onClear}>
          Clear
        </button>

        {popover != null && (
          <div ref={popRef} className="orgbar__pop" role="dialog" aria-label={`Set ${popover}`}>
            <input
              ref={inputRef}
              className="orgbar__input"
              value={input}
              placeholder={
                popover === "album"
                  ? "Album name"
                  : popover === "genre"
                    ? "Genre name"
                    : "Artist name"
              }
              aria-label={
                popover === "album"
                  ? "Album name"
                  : popover === "genre"
                    ? "Genre name"
                    : "Artist name"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim()) propose(input.trim());
              }}
            />
            <div className="orgbar__suggest">
              {matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="orgbar__suggestrow"
                  onClick={() => propose(m.name)}
                >
                  <span className="orgbar__suggestname">{m.name}</span>
                  <span className="orgbar__suggestcount">{m.track_count}</span>
                </button>
              ))}
              {q.trim() && !exactMatch && (
                <button
                  type="button"
                  className="orgbar__suggestrow orgbar__suggestrow--new"
                  onClick={() => propose(q.trim())}
                >
                  <span className="orgbar__suggestname">New “{q.trim()}”</span>
                </button>
              )}
              <button
                type="button"
                className="orgbar__suggestrow orgbar__suggestrow--clear"
                onClick={() => propose("")}
              >
                <span className="orgbar__suggestname">
                  {popover === "album"
                    ? "Clear album"
                    : popover === "album_artist"
                      ? "No album artist"
                      : popover === "genre"
                        ? "No genre"
                        : "No artist"}
                </span>
              </button>
              {matches.length === 0 && !q.trim() && (
                <div className="orgbar__empty">Type a name, or clear the field.</div>
              )}
            </div>
          </div>
        )}
      </div>

      {confirm != null && (
        <>
          <div className="orgsheet__scrim" onClick={() => setConfirm(null)} aria-hidden="true" />
          <div className="orgsheet" role="alertdialog" aria-label={confirmTitle} aria-modal="true">
            <h2 className="orgsheet__title">{confirmTitle}</h2>
            <p className="orgsheet__body">
              Applies to {count.toLocaleString()} {count === 1 ? "track" : "tracks"} in
              Flow's library. Your audio files are never modified.
            </p>
            <ConsequenceLine field={confirm.field} value={confirm.value} filterMode={filterMode} selectedTracks={selectedTracks} />
            <div className="orgsheet__actions">
              <button type="button" className="orgsheet__cancel" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn--primary"
                disabled={applying}
                onClick={() => {
                  const changes =
                    confirm.field === "album"
                      ? { album: confirm.value }
                      : confirm.field === "album_artist"
                        ? { album_artist: confirm.value }
                        : confirm.field === "genre"
                          ? { genre: confirm.value }
                          : { artist: confirm.value };
                  onApply(changes);
                  setConfirm(null);
                }}
              >
                {applying ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function ConsequenceLine({
  field,
  value,
  filterMode,
  selectedTracks,
}: {
  field: BulkField;
  value: string;
  filterMode: boolean;
  selectedTracks: Track[];
}) {
  const ids = useMemo(() => {
    const s = new Set<number>();
    for (const t of selectedTracks) {
      const id = field === "album" ? t.album_id : t.artist_id;
      if (id != null) s.add(id);
    }
    return [...s];
  }, [field, selectedTracks]);

  const details = useQuery({
    queryKey: ["consequences", field, ids],
    queryFn: async () => {
      const out: { id: number; title: string; track_count: number }[] = [];
      for (const id of ids) {
        if (field === "album") {
          const { data } = await api.GET("/api/albums/{album_id}", {
            params: { path: { album_id: id } },
          });
          if (data) out.push({ id, title: data.title, track_count: data.track_count });
        } else {
          const { data } = await api.GET("/api/artists/{artist_id}", {
            params: { path: { artist_id: id } },
          });
          if (data) out.push({ id, title: data.name, track_count: data.track_count });
        }
      }
      return out;
    },
    enabled: !filterMode && ids.length > 0 && field !== "genre",
  });
  const affected = useMemo(() => {
    if (filterMode || !details.data) return [];
    const target = value.trim();
    const counts = new Map<number, number>();
    for (const t of selectedTracks) {
      const id = field === "album" ? t.album_id : t.artist_id;
      if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const names: string[] = [];
    for (const d of details.data) {
      if (d.title.trim().toLowerCase() === target.toLowerCase()) continue;
      // Albums are removed exactly when their last track moves. Artists
      // can survive via album references even with no tracks, so the
      // claim is the one that is always true: left with no tracks.
      const fullyMoved = (counts.get(d.id) ?? 0) >= d.track_count;
      if (fullyMoved) names.push(d.title);
    }
    return names;
  }, [details.data, filterMode, field, value, selectedTracks]);

  const suffix = field === "album" ? "will be removed if left empty" : "will be left with no tracks";

  if (field === "album_artist") {
    return (
      <p className="orgsheet__note">
        The album keeps one album artist: the album page, its grouping, and
        future rescans of these tracks all follow the name you set.
      </p>
    );
  }
  if (field === "genre") {
    return (
      <p className="orgsheet__note">
        Genres are what the Tracks view's filter menu reads. A new
        name appears there immediately; a rescan keeps your choice.
      </p>
    );
  }
  if (filterMode) {
    return (
      <p className="orgsheet__note">
        Emptied albums and artists are removed automatically. Filter-wide
        selections can't preview which — check the grid if unsure.
      </p>
    );
  }
  if (affected.length === 0) return null;
  const shown = affected.slice(0, 3);
  const rest = affected.length - shown.length;
  return (
    <p className="orgsheet__note">
      <strong>{shown.map((n) => `“${n}”`).join(", ")}</strong>
      {rest > 0 ? ` and ${rest} more` : ""} {suffix}.
    </p>
  );
}
