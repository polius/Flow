/* The Organize album filter (2026-10-03): a searchable dropdown that pins
   the grid to one album — the organizing unit. Picking an album turns the
   view into "album mode": the rows show that album's curated order, the
   drag-reorder is armed, and a chip (with the review-strip's chips) carries
   the removable filter. The list is server-filtered (`q` on the albums
   endpoint), so a 10k-album library stays instant.

   The search input owns its own Esc: first Esc closes the menu and blurs —
   the sheet closes on the second, now-unfocused Esc (the filter field's
   grammar). */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { IconAlbums, IconClose, IconSearch } from "./icons";
import "../styles/organize.css";

interface AlbumFilterMenuProps {
  albumId: number | null;
  onChange: (albumId: number | null) => void;
}

export function AlbumFilterMenu({ albumId, onChange }: AlbumFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The current album's name for the pill — the same query key the
  // filter chip uses, so the cache is shared, not duplicated.
  const selected = useQuery({
    queryKey: ["album", albumId],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums/{album_id}", {
        params: { path: { album_id: albumId! } },
      });
      return data?.title ?? null;
    },
    enabled: albumId != null,
  });

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setDebounced(query.trim()), 150);
    return () => window.clearTimeout(t);
  }, [open, query]);

  const { data } = useQuery({
    queryKey: ["albums", "filter", debounced],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { limit: 50, sort: "title", dir: "asc", ...(debounced ? { q: debounced } : {}) } },
      });
      return data;
    },
    enabled: open,
    placeholderData: (prev) => prev,
  });

  // Menu lifecycle: outside tap closes, opening focuses the search.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const openMenu = () => {
    setQuery("");
    setDebounced("");
    setOpen(true);
    // Focus after mount — the input exists only while the menu is open.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const albums = data?.items ?? [];

  return (
    <div className="orgalbum" ref={wrapRef}>
      <button
        type="button"
        className={`orgalbum__button${albumId != null ? " orgalbum__button--on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        title="Filter by album"
      >
        <span className="orgalbum__icon" aria-hidden="true">
          <IconAlbums size={13} />
        </span>
        <span className="orgalbum__label">
          {albumId != null ? (selected.data ?? "Album…") : "All albums"}
        </span>
        {albumId != null && (
          <span
            role="button"
            tabIndex={-1}
            className="orgalbum__x"
            aria-label="Clear album filter"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          >
            <IconClose size={11} />
          </span>
        )}
      </button>
      {open && (
        <div className="orgalbum__pop" role="menu" aria-label="Choose an album">
          <div className="orgalbum__searchrow">
            <span className="orgalbum__searchicon" aria-hidden="true">
              <IconSearch size={13} />
            </span>
            <input
              ref={inputRef}
              className="orgalbum__search"
              value={query}
              placeholder="Filter albums"
              aria-label="Filter albums"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation(); // the sheet defers; the menu closes first
                  setOpen(false);
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
          <div className="orgalbum__list">
            {albums.map((album) => (
              <button
                key={album.id}
                type="button"
                role="menuitem"
                className={`orgalbum__row${album.id === albumId ? " orgalbum__row--on" : ""}`}
                onClick={() => {
                  onChange(album.id);
                  setOpen(false);
                }}
              >
                <span className="orgalbum__name">{album.title}</span>
                <span className="orgalbum__meta">
                  {album.artist ?? "No artist"} · {album.track_count}
                </span>
              </button>
            ))}
            {albums.length === 0 && (
              <div className="orgalbum__empty">No albums match “{debounced}”</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
