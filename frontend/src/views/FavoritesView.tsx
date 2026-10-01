import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import { playByFilter } from "../api/queue";
import type { QueueOrigin } from "../api/types";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { TrackTableHead, type TrackSortKey } from "../components/TrackTableHead";
import { VirtualTrackTable } from "../components/VirtualTrackTable";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconHeart, IconPlay, IconShuffle } from "../components/icons";
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

  const playTracks = usePlayerStore((s) => s.playTracks);
  const playSnapshot = usePlayerStore((s) => s.playSnapshot);

  // §1.1: the queue's origin — this view, named.
  const viewOrigin: QueueOrigin = {
    kind: "filter",
    label: "Favorites",
    href: "/favorites",
  };

  // "Play from here" means the whole view (§29), server-resolved when pages
  // of the filter are still unloaded (§32): POST /api/queue resolves the
  // WHOLE filter in one query — a 2,000-favorites queue is 2,000 tracks by
  // construction, not by fetching. A failed POST falls back to §29's
  // client-side whole-view fetch; a fully loaded view plays instantly and
  // the §32 mirror keeps the server honest.
  const playFromHere = useCallback(
    (index: number) => {
      if (tracks.length >= total) {
        playTracks(tracks, index, viewOrigin);
        return;
      }
      void playByFilter({
        q: q || undefined,
        favorite: true,
        sort,
        dir,
        start: index,
        origin: viewOrigin,
      }).then((snapshot) => {
        if (snapshot) {
          playSnapshot(snapshot);
          return;
        }
        return fetchAllTracks({ q: q || undefined, sort, dir, favorite: true }).then(
          (full) => {
            const list = full.length > 0 ? full : tracks;
            playTracks(list, Math.min(index, list.length - 1), viewOrigin);
          },
        );
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playTracks, playSnapshot, tracks, total, q, sort, dir],
  );

  const contextLoader = useCallback(
    () => fetchAllTracks({ q: q || undefined, sort, dir, favorite: true }),
    [q, sort, dir],
  );

  // Shuffle (§2.5's escape hatch, scoped to the view): the whole filter,
  // server-resolved and shuffled in one query (§32) — never a truncated
  // queue. Shuffle flips on before the call so the player bar tells the
  // truth about the plan (§30.1); the §29 client-side fetch is the
  // fallback, started at a random track with the store's order shuffled.
  const [shuffling, setShuffling] = useState(false);
  const shuffleAll = useCallback(() => {
    if (shuffling || total === 0) return;
    setShuffling(true);
    const start = Math.floor(Math.random() * total);
    usePlayerStore.getState().setShuffle(true);
    void playByFilter({
      q: q || undefined,
      favorite: true,
      sort,
      dir,
      start,
      shuffle: true,
      origin: viewOrigin,
    })
      .then((snapshot) => {
        if (snapshot) {
          playSnapshot(snapshot);
          return;
        }
        return fetchAllTracks({ q: q || undefined, sort, dir, favorite: true }).then(
          (full) => {
            const list = full.length > 0 ? full : tracks;
            if (list.length === 0) return;
            playTracks(list, Math.min(start, list.length - 1), viewOrigin);
          },
        );
      })
      .finally(() => setShuffling(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shuffling, total, q, sort, dir, playSnapshot, playTracks, tracks]);

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
            {/* §2.6: while the query is in flight the slot stays empty (the
                nbsp holds the line box — no layout shift) rather than
                formatting a zero. A computed "0" that isn't measured is a
                lie §16.6 forbids. */}
            {query.isPending
              ? "\u00A0"
              : q
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
              : // §2.3: the copy names the actual grammar — the heart is a
                // hover button on the row (always revealed on touch), and
                // the long-press menu is the touch path. The old sentence
                // sent users hunting for a row menu that no longer exists.
                "Touch the heart on any row — or press and hold a row (right-click on desktop) for more."
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
