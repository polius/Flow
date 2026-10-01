import { useCallback, useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { TrackTableHead, type TrackSortKey } from "../components/TrackTableHead";
import { VirtualTrackTable } from "../components/VirtualTrackTable";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconHeart, IconPlay } from "../components/icons";
import { fmtCount } from "../lib/format";
import { usePlayerStore } from "../stores/player";

/* Favorites — the library's loved songs, first-class (§9.1). The heart is a
   state indicator on every row; this view is where the state lands. Same
   windowed table + URL sort state as Tracks, so the two views share one
   mental model and one set of gestures (headers, long-press menu). */
const PAGE_SIZE = 1000;

const SORT_OPTIONS: SortOption[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "duration", label: "Duration" },
  { key: "year", label: "Year" },
  { key: "added_at", label: "Recently added", defaultDir: "desc" },
];

const SORT_KEYS = new Set(SORT_OPTIONS.map((o) => o.key));

export function FavoritesView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const urlSort = searchParams.get("sort") ?? "added_at";
  const sort = (SORT_KEYS.has(urlSort) ? urlSort : "added_at") as TrackSortKey;
  const dir = searchParams.get("dir") === "asc" ? "asc" : "desc";

  const playTracks = usePlayerStore((s) => s.playTracks);

  const query = useInfiniteQuery({
    queryKey: ["tracks", "favorites", q, sort, dir],
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET("/api/tracks", {
        params: {
          query: {
            limit: PAGE_SIZE,
            offset: pageParam,
            favorite: true,
            sort,
            dir,
            ...(q ? { q } : {}),
          },
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
  const total = query.data?.pages[0]?.total ?? 0;

  // "Play from here" means the whole view (§29): pages beyond the loaded
  // ones are fetched before the queue is built, so a 2,000-favorites queue
  // is 2,000 tracks — never whatever the window had loaded.
  const playFromHere = useCallback(
    (index: number) => {
      if (tracks.length >= total) {
        playTracks(tracks, index);
        return;
      }
      const loaded = tracks;
      void fetchAllTracks({ q: q || undefined, sort, dir, favorite: true })
        .then((full) =>
          playTracks(
            full.length > 0 ? full : loaded,
            Math.min(index, (full.length > 0 ? full : loaded).length - 1),
          ),
        )
        .catch(() => playTracks(loaded, index));
    },
    [playTracks, tracks, total, q, sort, dir],
  );

  const contextLoader = useCallback(
    () => fetchAllTracks({ q: q || undefined, sort, dir, favorite: true }),
    [q, sort, dir],
  );

  const handleNearEnd = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const onSort = useCallback(
    (key: TrackSortKey, nextDir: "asc" | "desc") => {
      const next = new URLSearchParams(searchParams);
      next.set("sort", key);
      next.set("dir", nextDir);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    document.querySelector<HTMLElement>(".shell__canvas")?.scrollTo(0, 0);
  }, [sort, dir]);

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Favorites</h1>
          <p className="view__subtitle">
            {q
              ? `${fmtCount(total)} ${total === 1 ? "match" : "matches"} for “${q}”`
              : `${fmtCount(total)} ${total === 1 ? "song" : "songs"} you’ve loved`}
          </p>
        </div>
        <div className="view__actions">
          <SortMenu
            options={SORT_OPTIONS}
            value={sort}
            dir={dir}
            onChange={(key, nextDir) => onSort(key as TrackSortKey, nextDir)}
            label="Sort favorites"
          />
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
              : "Touch the heart on any track’s menu — press and hold a row (or right-click it) and choose Add to Favorites."
          }
        />
      ) : (
        <>
          <TrackTableHead sort={sort} dir={dir} onSort={onSort} />
          <VirtualTrackTable
            tracks={tracks}
            onNearEnd={handleNearEnd}
            onPlay={playFromHere}
            contextLoader={contextLoader}
          />
        </>
      )}
    </section>
  );
}
