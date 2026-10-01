import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";

import { api } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconArtists } from "../components/icons";
import { fmtCount } from "../lib/format";
import { TrackTable } from "../components/TrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
import "../styles/library.css";

export function ArtistDetailView() {
  const artistId = Number(useParams().artistId);

  const { data: artist } = useQuery({
    queryKey: ["artist", artistId],
    queryFn: async () => {
      const { data, response } = await api.GET("/api/artists/{artist_id}", {
        params: { path: { artist_id: artistId } },
      });
      if (!response.ok) return null;
      return data;
    },
    enabled: Number.isFinite(artistId),
  });

  if (artist === null) {
    return (
      <section className="view">
        <EmptyState
          icon={<IconArtists size={26} />}
          title="Artist not found"
          hint="They may have been removed during a library rescan."
        />
      </section>
    );
  }

  if (artist === undefined) {
    return (
      <section className="view">
        <LoadingState variant="detail" />
      </section>
    );
  }

  return (
    <section className="view">
      <header className="detailhead">
        <div className="detailhead__info">
          <p className="detailhead__kind">Artist</p>
          <h1 className="detailhead__title">{artist.name}</h1>
          <p className="detailhead__meta">
            {fmtCount(artist.album_count)} album
            {artist.album_count === 1 ? "" : "s"} · {fmtCount(artist.track_count)} song
            {artist.track_count === 1 ? "" : "s"}
          </p>
        </div>
      </header>

      {artist.albums.length > 0 && (
        <div className="libsection">
          <h2>Albums</h2>
          <div className="covergrid">
            {artist.albums.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </div>
      )}

      {artist.tracks.length > 0 && (
        <div className="libsection">
          <h2>Songs</h2>
          <TrackTableHead variant="artist" />
          <TrackTable tracks={artist.tracks} variant="artist" />
        </div>
      )}
    </section>
  );
}
