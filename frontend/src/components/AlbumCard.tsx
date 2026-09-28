/* Album cover card for grids (§9.2): art-forward, hover reveals play. */

import { Link } from "react-router";

import { api } from "../api/client";
import type { AlbumSummary } from "../api/types";
import { usePlayerStore } from "../stores/player";
import { Artwork } from "./Artwork";
import { IconPlay } from "./icons";
import "../styles/library.css";

export function AlbumCard({ album }: { album: AlbumSummary }) {
  const playTracks = usePlayerStore((s) => s.playTracks);

  const play = async () => {
    const { data } = await api.GET("/api/albums/{album_id}", {
      params: { path: { album_id: album.id } },
    });
    if (data && data.tracks.length > 0) playTracks(data.tracks, 0);
  };

  return (
    <div className="album-card">
      <div className="album-card__artwrap">
        <Link to={`/albums/${album.id}`} className="album-card__artlink" aria-label={album.title}>
          <Artwork artworkId={album.artwork_id} size={180} radius="m" className="album-card__art" />
        </Link>
        <button
          type="button"
          className="album-card__play"
          onClick={play}
          aria-label={`Play ${album.title}`}
          title="Play album"
        >
          <IconPlay size={20} />
        </button>
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
