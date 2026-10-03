import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import type { Track, TrackList } from "../api/types";
import { useReorderFavorites } from "../api/mutations";
import { playByFilter } from "../api/queue";
import type { QueueOrigin } from "../api/types";
import { VirtualTrackTable } from "../components/VirtualTrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconHeart, IconPlay, IconShuffle } from "../components/icons";
import { fmtCount } from "../lib/format";
import { usePlayerStore } from "../stores/player";

/* Favorites is a curated list — no sort menu. The order is the drag-written
   manual one (favorite_position 1..n, persisted server-side); a search
   filter narrows the list but never re-sorts it behind the user's back. */

const PAGE_SIZE = 1000;

export function FavoritesView() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const query = useInfiniteQuery({
    queryKey: ["tracks", "favorites", q],
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET("/api/tracks", {
        params: {
          query: {
            limit: PAGE_SIZE,
            offset: pageParam,
            favorite: true,
            sort: "favorite",
            dir: "asc",
            ...(q ? { q } : {}),
          },
        },
      });
      return data;
    },
    initialPageParam: 0,
    // Keep the previous order on screen while a refetch lands — the table
    // swaps orders in one paint, not a skeleton.
    placeholderData: (prev) => prev,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + (p?.items.length ?? 0), 0);
      return loaded < (lastPage?.total ?? 0) ? loaded : undefined;
    },
  });

  const tracks = useMemo(
    () => query.data?.pages.flatMap((p) => p?.items ?? []) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;

  const playTracks = usePlayerStore((s) => s.playTracks);
  const playSnapshot = usePlayerStore((s) => s.playSnapshot);

  const viewOrigin: QueueOrigin = {
    kind: "filter",
    label: "Favorites",
    href: "/favorites",
  };

  // "Play from here" means the whole view: when pages of the filter are
  // still unloaded, the server resolves the WHOLE filter in one query (a
  // 2,000-favorites queue is 2,000 tracks by construction, not by
  // fetching); a failed POST falls back to the client-side whole-view
  // fetch. A fully loaded view plays instantly.
  const playFromHere = useCallback(
    (index: number) => {
      if (tracks.length >= total) {
        playTracks(tracks, index, viewOrigin);
        return;
      }
      void playByFilter({
        q: q || undefined,
        favorite: true,
        sort: "favorite",
        dir: "asc",
        start: index,
        origin: viewOrigin,
      }).then((snapshot) => {
        if (snapshot) {
          playSnapshot(snapshot);
          return;
        }
        return fetchAllTracks({
          q: q || undefined,
          sort: "favorite",
          dir: "asc",
          favorite: true,
        }).then((full) => {
          const list = full.length > 0 ? full : tracks;
          playTracks(list, Math.min(index, list.length - 1), viewOrigin);
        });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playTracks, playSnapshot, tracks, total, q],
  );

  const contextLoader = useCallback(
    () =>
      fetchAllTracks({ q: q || undefined, sort: "favorite", dir: "asc", favorite: true }),
    [q],
  );

  // Shuffle the whole filter server-side — never a truncated queue. Shuffle
  // flips on before the call so the player bar tells the truth about the
  // plan; the client-side fetch is the fallback.
  const [shuffling, setShuffling] = useState(false);
  const shuffleAll = useCallback(() => {
    if (shuffling || total === 0) return;
    setShuffling(true);
    const start = Math.floor(Math.random() * total);
    usePlayerStore.getState().setShuffle(true);
    void playByFilter({
      q: q || undefined,
      favorite: true,
      sort: "favorite",
      dir: "asc",
      start,
      shuffle: true,
      origin: viewOrigin,
    })
      .then((snapshot) => {
        if (snapshot) {
          playSnapshot(snapshot);
          return;
        }
        return fetchAllTracks({
          q: q || undefined,
          sort: "favorite",
          dir: "asc",
          favorite: true,
        }).then((full) => {
          const list = full.length > 0 ? full : tracks;
          if (list.length === 0) return;
          playTracks(list, Math.min(start, list.length - 1), viewOrigin);
        });
      })
      .finally(() => setShuffling(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shuffling, total, q, playSnapshot, playTracks, tracks]);

  const handleNearEnd = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const queryClient = useQueryClient();
  const reorderFavorites = useReorderFavorites();

  // Only offer the drag when every favorite is loaded and no search filter
  // narrows the subset — reordering a partial or filtered read would
  // silently re-point rows the screen can't show.
  const reorderable = !q && tracks.length > 1 && tracks.length >= total;

  const move = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      const ids = tracks.map((t) => t.id);
      const [moved] = ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, moved);
      // Optimistic rewrite of the cached pages: one flat splice,
      // redistributed by the same PAGE_SIZE the query fetched with; the
      // server PUT confirms behind it.
      queryClient.setQueryData<{ pages: (TrackList | undefined)[]; pageParams: unknown[] }>(
        ["tracks", "favorites", q],
        (data) => {
          if (!data) return data;
          const flat = data.pages.flatMap((p) => p?.items ?? []);
          const [movedTrack] = flat.splice(fromIndex, 1);
          flat.splice(toIndex, 0, movedTrack);
          const pages = data.pages.map((page, i) => {
            if (!page) return page;
            return {
              ...page,
              items: flat
                .slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
                .map((t): Track => ({ ...t })),
              offset: i * PAGE_SIZE,
            };
          });
          return { ...data, pages };
        },
      );
      void reorderFavorites(ids);
    },
    [tracks, q, queryClient, reorderFavorites],
  );

  useEffect(() => {
    document.querySelector<HTMLElement>(".shell__canvas")?.scrollTo(0, 0);
  }, [q]);

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Favorites</h1>
          <p className="view__subtitle">
            {/* While the query is in flight the nbsp holds the line box — no
                layout shift, and no "0 songs" flash before the count is
                measured. */}
            {query.isPending
              ? "\u00A0"
              : q
                ? `${fmtCount(total)} ${total === 1 ? "match" : "matches"} for “${q}”`
                : `${fmtCount(total)} ${total === 1 ? "song" : "songs"} you’ve loved`}
          </p>
        </div>
        <div className="view__actions">
          {total > 0 && (
            <button
              type="button"
              className="view__action"
              onClick={shuffleAll}
              disabled={shuffling}
              aria-label="Shuffle favorites"
              title="Shuffle all favorites"
            >
              <IconShuffle size={13} />
              Shuffle
            </button>
          )}
          {tracks.length > 0 && (
            <button
              type="button"
              className="view__action view__action--play"
              onClick={() => playFromHere(0)}
              aria-label="Play favorites"
              title="Play all favorites"
            >
              <IconPlay size={13} />
              Play
            </button>
          )}
        </div>
      </div>
      {query.isPending ? (
        <LoadingState variant="rows" />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon={<IconHeart size={26} />}
          title={q ? `No favorites match “${q}”` : "No favorites yet"}
          hint={
            q
              ? "Try a different word."
              : "Touch the heart on any row — or press and hold a row (right-click on desktop) for more."
          }
        />
      ) : (
        <>
          <TrackTableHead />
          <VirtualTrackTable
            tracks={tracks}
            onNearEnd={handleNearEnd}
            onPlay={playFromHere}
            contextLoader={contextLoader}
            onMove={move}
            reorderable={reorderable}
          />
        </>
      )}
    </section>
  );
}
