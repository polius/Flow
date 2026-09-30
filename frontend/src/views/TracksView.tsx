import { useCallback, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { NavLink, useSearchParams } from "react-router";

import { api } from "../api/client";
import { VirtualTrackTable } from "../components/VirtualTrackTable";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { useReviewSummary } from "../components/ReviewStrip";
import { IconOrganize, IconTracks } from "../components/icons";

/* Full-library view, windowed (§9.2, §11.6). Pages of 1000 stream in behind
   the virtualizer as the user scrolls — the M3 "first 1000" cap and its
   truncation notice are gone. §23: the view's header carries the Organize
   entry (the nav icon is gone) with the "needs attention" count riding
   along — the task launches from where the mess is visible. */
const PAGE_SIZE = 1000;

export function TracksView() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const summary = useReviewSummary();
  const reviewCount = useMemo(() => {
    const s = summary.data;
    if (!s) return 0;
    return (
      s.no_album +
      s.single_track_albums +
      s.mixed_album_artist_albums +
      s.missing_track_no +
      s.suffix_collisions
    );
  }, [summary.data]);

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
      <div className="view__head">
        <h1 className="view__title">Tracks</h1>
        <NavLink
          to="/organize"
          className="view__action"
          aria-label={
            reviewCount > 0
              ? `Organize — ${reviewCount} ${reviewCount === 1 ? "item needs" : "items need"} attention`
              : "Organize"
          }
          title="Organize — group tracks into albums and artists"
        >
          <IconOrganize size={15} />
          Organize
          {reviewCount > 0 && <span className="view__actioncount">{reviewCount}</span>}
        </NavLink>
      </div>
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
