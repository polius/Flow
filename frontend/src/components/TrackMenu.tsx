/* Hover-revealed row menu (§8.7): play next, add to playlist, get info.
   Drill-down style ("Add to Playlist" swaps content) — no nested hover menus. */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import type { Track } from "../api/types";
import { useAddToPlaylist, useCreatePlaylist } from "../api/mutations";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { IconPlus } from "./icons";

interface TrackMenuProps {
  track: Track;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** Present only inside a playlist detail — removes the track from it. */
  onRemoveFromPlaylist?: () => void;
}

type MenuPage = "root" | "addTo";

export function TrackMenu({ track, anchor, onClose, onRemoveFromPlaylist }: TrackMenuProps) {
  const [page, setPage] = useState<MenuPage>("root");
  const menuRef = useRef<HTMLDivElement>(null);
  const playNext = usePlayerStore((s) => s.playNext);
  const openGetInfo = useUiStore((s) => s.openGetInfo);
  const addToPlaylist = useAddToPlaylist();
  const createPlaylist = useCreatePlaylist();

  const { data: playlistsData } = useQuery({
    queryKey: ["playlists", "menu"],
    queryFn: async () => {
      const { data } = await api.GET("/api/playlists", {
        params: { query: { limit: 1000 } },
      });
      return data;
    },
    enabled: page === "addTo",
  });
  const playlists = playlistsData?.items ?? [];

  useEffect(() => {
    // Registered so global Esc/shortcut handling knows a menu is on top
    // (§15.7 precedence: menus close before panels and views).
    useUiStore.getState().setContextMenuOpen(true);
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      useUiStore.getState().setContextMenuOpen(false);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Keep the menu on screen; flip above/left when near an edge.
  const style: React.CSSProperties = {
    left: Math.min(anchor.x, window.innerWidth - 240),
    top: Math.min(anchor.y, window.innerHeight - 320),
  };

  const item = (label: string, action: () => void, danger = false) => (
    <button
      key={label}
      type="button"
      className={`trackmenu__item${danger ? " trackmenu__item--danger" : ""}`}
      onClick={() => {
        action();
        onClose();
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={menuRef} className="trackmenu" style={style} role="menu" aria-label="Track actions">
      {page === "root" ? (
        <>
          {item("Play Next", () => playNext(track))}
          <button
            type="button"
            className="trackmenu__item"
            onClick={() => setPage("addTo")}
          >
            Add to Playlist…
          </button>
          {item("Get Info", () => openGetInfo(track.id))}
          {onRemoveFromPlaylist &&
            item("Remove from Playlist", onRemoveFromPlaylist, true)}
        </>
      ) : (
        <>
          <button
            type="button"
            className="trackmenu__item trackmenu__item--new"
            onClick={async () => {
              const created = await createPlaylist();
              if (created) await addToPlaylist(created.id, [track.id]);
              onClose();
            }}
          >
            <IconPlus size={14} />
            New Playlist
          </button>
          <div className="trackmenu__separator" role="separator" />
          {playlists.map((p) => (
            <button
              key={p.id}
              type="button"
              className="trackmenu__item"
              onClick={async () => {
                await addToPlaylist(p.id, [track.id]);
                onClose();
              }}
            >
              {p.name}
            </button>
          ))}
          {playlists.length === 0 && (
            <div className="trackmenu__empty">No playlists yet</div>
          )}
        </>
      )}
    </div>
  );
}
