import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { api } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconArtists } from "../components/icons";
import { fmtCount } from "../lib/format";

export function ArtistsView() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const { data } = useQuery({
    queryKey: ["artists", q],
    queryFn: async () => {
      const { data } = await api.GET("/api/artists", {
        params: { query: { limit: 1000, ...(q ? { q } : {}) } },
      });
      return data;
    },
  });

  const artists = data?.items ?? [];

  return (
    <section className="view">
      <h1 className="view__title">Artists</h1>
      {data === undefined ? (
        <LoadingState variant="rows" />
      ) : artists.length === 0 ? (
        <EmptyState
          icon={<IconArtists size={26} />}
          title={q ? `No artists match “${q}”` : "No artists yet"}
          hint={
            q
              ? "Try a different word, or search everything from the Search view."
              : "Artists appear here once the library has been scanned."
          }
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
