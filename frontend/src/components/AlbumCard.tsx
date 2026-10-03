/* Album cover card for grids (§9.2): art-forward, hover reveals play.
   §2.1 adds the "…" beside it: the per-album slice of the header trio, so
   curation works from any grid (Home, Albums, an artist's page, Search) —
   the actions resolve the album's full track list on demand. */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import type { AlbumSummary, QueueOrigin } from "../api/types";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import { IconEllipsis, IconNext, IconPlay, IconPlus, IconQueue, IconShuffle } from "./icons";
import "../styles/library.css";

export function AlbumCard({ album }: { album: AlbumSummary }) {
  const playTracks = usePlayerStore((s) => s.playTracks);
  const playNextMany = usePlayerStore((s) => s.playNextMany);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // The album IS the origin (§1.1): playing or shuffling the card names
  // it, so the queue's "Playing from" sentence is born telling the truth.
  const origin: QueueOrigin = {
    kind: "album",
    label: album.title,
    href: `/albums/${album.id}`,
  };

  // Tracks resolve when the menu asks for them — never on grid render.
  const { data: detail } = useQuery({
    queryKey: ["album", album.id],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums/{album_id}", {
        params: { path: { album_id: album.id } },
      });
      return data;
    },
    enabled: menuOpen,
  });
  const tracks = detail?.tracks ?? [];

  // Shared menu lifecycle: outside tap, Esc, navigation teardown.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const act = (fn: () => void) => () => {
    fn();
    setMenuOpen(false);
  };

  const play = () => {
    if (tracks.length > 0) playTracks(tracks, 0, origin);
  };
  const shuffle = () => {
    if (tracks.length === 0) return;
    const start = Math.floor(Math.random() * tracks.length);
    usePlayerStore.getState().setShuffle(true);
    playTracks(tracks, start, origin);
  };
  const loading = menuOpen && detail === undefined;

  return (
    <div className="album-card">
      <div className="album-card__artwrap">
        <Link to={`/albums/${album.id}`} className="album-card__artlink" aria-label={album.title}>
          <Artwork
            artworkId={album.cover_artwork_id ?? album.artwork_id}
            size={180}
            radius="m"
            className="album-card__art"
          />
        </Link>
        <div className="album-card__hoveractions" ref={menuRef}>
          <button
            type="button"
            className="album-card__play"
            onClick={play}
            disabled={loading || tracks.length === 0}
            aria-label={`Play ${album.title}`}
            title="Play album"
          >
            <IconPlay size={20} />
          </button>
          <button
            type="button"
            className="album-card__more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${album.title}`}
            title="Album actions"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <IconEllipsis size={16} />
          </button>
          {menuOpen && (
            <div className="trackmenu album-card__menu" role="menu" aria-label={`Actions for ${album.title}`}>
              <button type="button" role="menuitem" className="trackmenu__item" onClick={act(play)}>
                <IconPlay size={15} />
                Play
              </button>
              <button type="button" role="menuitem" className="trackmenu__item" onClick={act(shuffle)}>
                <IconShuffle size={15} />
                Shuffle
              </button>
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                onClick={act(() => playNextMany(tracks))}
                disabled={loading || tracks.length === 0}
              >
                <IconNext size={15} />
                Play Next
              </button>
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                onClick={act(() => addToQueue(tracks))}
                disabled={loading || tracks.length === 0}
              >
                <IconQueue size={15} />
                Add to Queue (end)
              </button>
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                onClick={act(() => openAddToPlaylist(tracks))}
                disabled={loading || tracks.length === 0}
              >
                <IconPlus size={15} />
                Add to Playlist
              </button>
            </div>
          )}
        </div>
      </div>
      <Link to={`/albums/${album.id}`} className="album-card__title">
        {album.title}
      </Link>
      <div className="album-card__meta">
        {album.artist ?? "Unknown artist"}
        {album.year != null ? ` · ${album.year}` : ""}
      </div>
    </div>
  );
}
