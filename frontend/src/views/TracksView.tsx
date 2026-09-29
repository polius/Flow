import { useCallback, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api } from "../api/client";
import { VirtualTrackTable } from "../components/VirtualTrackTable";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconTracks } from "../components/icons";

/* Full-library view, windowed (§9.2, §11.6). Pages of 1000 stream in behind
   the virtualizer as the user scrolls — the M3 "first 1000" cap and its
   truncation notice are gone. */
const PAGE_SIZE = 1000;

export function TracksView() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const query = useInfiniteQuery({
    queryKey: ["tracks", "all", q],
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET("/api/tracks", {
        params: {
          query: { limit: PAGE_SIZE, offset: pageParam, ...(q ? { q } : {}) },
        },
      });
      return data;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + (p?.items.length ?? 0), 0);
      return loaded < (lastPage?.total ?? 0) ? loaded : undefined;
    },
  });

  const tracks = useMemo(
    () => query.data?.pages.flatMap((p) => p?.items ?? []) ?? [],
    [query.data],
  );

  const handleNearEnd = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  return (
    <section className="view">
      <h1 className="view__title">Tracks</h1>
      {query.isPending ? (
        <LoadingState variant="rows" />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon={<IconTracks size={26} />}
          title={q ? `No tracks match “${q}”` : "No tracks yet"}
          hint={
            q
              ? "Try a different word, or search everything from the Search view."
              : "Every song in your library will live here, in a table built to stay smooth at ten thousand tracks."
          }
        />
      ) : (
        <VirtualTrackTable tracks={tracks} onNearEnd={handleNearEnd} />
      )}
    </section>
  );
}
