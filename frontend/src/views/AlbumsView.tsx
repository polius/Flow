import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { EmptyState } from "../components/EmptyState";
import { IconAlbums } from "../components/icons";

export function AlbumsView() {
  const { data } = useQuery({
    queryKey: ["albums"],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { limit: 1000 } },
      });
      return data;
    },
  });

  const albums = data?.items ?? [];

  return (
    <section className="view">
      <h1 className="view__title">Albums</h1>
      {albums.length === 0 ? (
        <EmptyState
          icon={<IconAlbums size={26} />}
          title="No albums yet"
          hint="Albums appear here once the library has been scanned."
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
