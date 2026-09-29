/* Playlists — card grid with 2×2 artwork mosaics (§9.2, §13.10). */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";

import { api } from "../api/client";
import type { PlaylistSummary } from "../api/types";
import { useCreatePlaylist, useDeletePlaylist } from "../api/mutations";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconMore, IconPlay, IconPlaylists } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { fmtCount, fmtMinutes } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import "../styles/library.css";
import "../styles/editing.css";

export function PlaylistsView() {
  const navigate = useNavigate();
  const createPlaylist = useCreatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const [menu, setMenu] = useState<{ playlist: PlaylistSummary; x: number; y: number } | null>(
    null,
  );

  const { data } = useQuery({
    queryKey: ["playlists"],
    queryFn: async () => {
      const { data } = await api.GET("/api/playlists", { params: { query: { limit: 1000 } } });
      return data;
    },
  });

  const playlists = data?.items ?? [];

  return (
    <section className="view">
      <header className="view__head">
        <h1 className="view__title">Playlists</h1>
        <button
          type="button"
          className="view__action"
          onClick={async () => {
            const created = await createPlaylist();
            if (created) navigate(`/playlists/${created.id}`);
          }}
        >
          New Playlist
        </button>
      </header>

      {data === undefined ? (
        <LoadingState variant="grid" />
      ) : playlists.length === 0 ? (
        <EmptyState
          icon={<IconPlaylists size={26} />}
          title="No playlists yet"
          hint="Create a playlist and drag songs in — reorder them any time."
        />
      ) : (
        <div className="covergrid">
          {playlists.map((playlist) => (
            <PlaylistCard
              key={playlist.id}
              playlist={playlist}
              onMenu={(x, y) => setMenu({ playlist, x, y })}
            />
          ))}
        </div>
      )}

      {menu && (
        <PlaylistMenu
          playlist={menu.playlist}
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          onDelete={async () => {
            await deletePlaylist(menu.playlist.id);
          }}
        />
      )}
    </section>
  );
}

function PlaylistCard({
  playlist,
  onMenu,
}: {
  playlist: PlaylistSummary;
  onMenu: (x: number, y: number) => void;
}) {
  const playTracks = usePlayerStore((s) => s.playTracks);

  const play = async () => {
    const { data } = await api.GET("/api/playlists/{playlist_id}", {
      params: { path: { playlist_id: playlist.id } },
    });
    if (data && data.tracks.length > 0) playTracks(data.tracks, 0);
  };

  return (
    <div className="album-card">
      <div className="album-card__artwrap">
        <Link to={`/playlists/${playlist.id}`} className="album-card__artlink" aria-label={playlist.name}>
          <PlaylistArt artworkIds={playlist.artwork_ids} size={180} radius="m" className="album-card__art" />
        </Link>
        <button
          type="button"
          className="album-card__play"
          onClick={play}
          disabled={playlist.track_count === 0}
          aria-label={`Play ${playlist.name}`}
          title="Play playlist"
        >
          <IconPlay size={20} />
        </button>
      </div>
      <Link to={`/playlists/${playlist.id}`} className="album-card__title">
        {playlist.name}
      </Link>
      <div className="album-card__meta">
        {fmtCount(playlist.track_count)} track{playlist.track_count === 1 ? "" : "s"}
        {playlist.track_count > 0 ? ` · ${fmtMinutes(playlist.duration_total)}` : ""}
      </div>
      <button
        type="button"
        className="playlist-card__more"
        aria-label={`Actions for ${playlist.name}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(e.clientX, e.clientY);
        }}
      >
        <IconMore size={16} />
      </button>
    </div>
  );
}

function PlaylistMenu({
  playlist,
  anchor,
  onClose,
  onDelete,
}: {
  playlist: PlaylistSummary;
  anchor: { x: number; y: number };
  onClose: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    left: Math.min(anchor.x, window.innerWidth - 220),
    top: Math.min(anchor.y, window.innerHeight - 140),
  };

  return (
    <div ref={ref} className="trackmenu" style={style} role="menu" aria-label="Playlist actions">
      <Link to={`/playlists/${playlist.id}`} className="trackmenu__item" onClick={onClose}>
        Open
      </Link>
      <button
        type="button"
        className="trackmenu__item trackmenu__item--danger"
        onClick={() => {
          if (window.confirm(`Delete “${playlist.name}”? This cannot be undone.`)) {
            onDelete();
          }
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}
