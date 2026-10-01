import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconAlbums } from "../components/icons";
import { fmtCount } from "../lib/format";

export function AlbumsView() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const { data } = useQuery({
    queryKey: ["albums", q],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { limit: 1000, ...(q ? { q } : {}) } },
      });
      return data;
    },
  });

  const albums = data?.items ?? [];

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Albums</h1>
          <p className="view__subtitle">
            {q
              ? `${fmtCount(albums.length)} ${albums.length === 1 ? "match" : "matches"} for "${q}"`
              : `${fmtCount(albums.length)} ${albums.length === 1 ? "album" : "albums"}`}
          </p>
        </div>
      </div>
      {data === undefined ? (
        <LoadingState variant="grid" />
      ) : albums.length === 0 ? (
        <EmptyState
          icon={<IconAlbums size={26} />}
          title={q ? `No albums match “${q}”` : "No albums yet"}
          hint={
            q
              ? "Try a different word, or search everything from the Search view."
              : "Albums appear here once the library has been scanned."
          }
        />
      ) : (
        <div className="covergrid">
          {albums.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      )}
    </section>
  );
}
