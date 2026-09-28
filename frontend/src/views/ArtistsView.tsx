import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { IconArtists } from "../components/icons";
import { fmtCount } from "../lib/format";

export function ArtistsView() {
  const { data } = useQuery({
    queryKey: ["artists"],
    queryFn: async () => {
      const { data } = await api.GET("/api/artists", {
        params: { query: { limit: 1000 } },
      });
      return data;
    },
  });

  const artists = data?.items ?? [];

  return (
    <section className="view">
      <h1 className="view__title">Artists</h1>
      {artists.length === 0 ? (
        <EmptyState
          icon={<IconArtists size={26} />}
          title="No artists yet"
          hint="Artists appear here once the library has been scanned."
        />
      ) : (
        <div className="artistlist">
          {artists.map((artist) => (
            <Link key={artist.id} to={`/artists/${artist.id}`} className="artistrow">
              <span>{artist.name}</span>
              <span className="artistrow__counts">
                {fmtCount(artist.album_count)} album
                {artist.album_count === 1 ? "" : "s"} · {fmtCount(artist.track_count)} song
                {artist.track_count === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
