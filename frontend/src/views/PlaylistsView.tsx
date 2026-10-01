/* Playlists — card grid with 2×2 artwork mosaics (§9.2, §13.10).
   Cards are entry points only; editing and deleting live in the
   playlist's Manage dialog. */

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";

import { api } from "../api/client";
import type { PlaylistSummary } from "../api/types";
import { useCreatePlaylist } from "../api/mutations";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconPlay, IconPlaylists } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { fmtCount, fmtMinutes } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import "../styles/library.css";
import "../styles/editing.css";

export function PlaylistsView() {
  const navigate = useNavigate();
  const createPlaylist = useCreatePlaylist();

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
        <div>
          <h1 className="view__title">Playlists</h1>
          <p className="view__subtitle">
            {fmtCount(playlists.length)} {playlists.length === 1 ? "playlist" : "playlists"}
          </p>
        </div>
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
            <PlaylistCard key={playlist.id} playlist={playlist} />
          ))}
        </div>
      )}
    </section>
  );
}

function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  const playTracks = usePlayerStore((s) => s.playTracks);

  const play = async () => {
    const { data } = await api.GET("/api/playlists/{playlist_id}", {
      params: { path: { playlist_id: playlist.id } },
    });
    if (data && data.tracks.length > 0)
      playTracks(data.tracks, 0, {
        kind: "playlist",
        label: playlist.name,
        href: `/playlists/${playlist.id}`,
      });
  };

  return (
    <div className="album-card">
      <div className="album-card__artwrap">
        <Link to={`/playlists/${playlist.id}`} className="album-card__artlink" aria-label={playlist.name}>
          <PlaylistArt
            artworkIds={playlist.artwork_ids}
            coverArtworkId={playlist.cover_artwork_id}
            size={180}
            radius="m"
            className="album-card__art"
          />
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
    </div>
  );
}
