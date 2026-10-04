import { useCallback, useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import { playByFilter } from "../api/queue";
import type { QueueOrigin } from "../api/types";
import { GenreMenu } from "../components/GenreMenu";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { TrackTableHead, type TrackSortKey } from "../components/TrackTableHead";
import { VirtualTrackTable } from "../components/VirtualTrackTable";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { useReviewCount } from "../components/ReviewStrip";
import { IconOrganize, IconTracks } from "../components/icons";
import { fmtCount } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

/* Full-library view, windowed: pages of 1000 stream in behind the
   virtualizer as the user scrolls. */
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

export function TracksView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const urlSort = searchParams.get("sort") ?? "title";
  const sort = (SORT_KEYS.has(urlSort) ? urlSort : "title") as TrackSortKey;
  const dir = searchParams.get("dir") === "desc" ? "desc" : "asc";
  // Genre filter: ?genre=<id>, validated against the genres query.
  const urlGenre = searchParams.get("genre");
  const genreId = urlGenre != null && /^\d+$/.test(urlGenre) ? Number(urlGenre) : null;

  const openOrganize = useUiStore((s) => s.openOrganize);

  // The genres list doubles as the subtitle's vocabulary — the menu and the
  // subtitle share the query cache, so this costs one request app-wide.
  const { data: genresData } = useQuery({
    queryKey: ["genres"],
    queryFn: async () => {
      const { data } = await api.GET("/api/genres", {
        params: { query: { limit: 1000 } },
      });
      return data;
    },
  });
  const genreName =
    genresData?.items.find((g) => g.id === genreId)?.name ?? null;

  const reviewCount = useReviewCount();

  const query = useInfiniteQuery({
    queryKey: ["tracks", "all", q, sort, dir, genreId],
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET("/api/tracks", {
        params: {
          query: {
            limit: PAGE_SIZE,
            offset: pageParam,
            sort,
            dir,
            ...(q ? { q } : {}),
            ...(genreId != null ? { genre_id: genreId } : {}),
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
    // A re-sort must not tear the table down to a skeleton while it fetches
    // (the header-click "glitch"): the previous rows stay mounted and the
    // refetched order swaps in in one paint.
    placeholderData: (prev) => prev,
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
    label: genreName
      ? genreName
      : q
        ? `“${q}”`
        : "Your Library",
    href: genreName && genreId != null
      ? `/tracks?genre=${genreId}`
      : q
        ? `/tracks?q=${encodeURIComponent(q)}`
        : "/tracks",
  };

  // "Play from here" means the whole view: when pages of this filter are
  // still unloaded, the server resolves the WHOLE filter in one query —
  // there is no page for the queue to be truncated to. When everything is
  // already local, play instantly; a failed POST falls back to the
  // client-side whole-view fetch.
  const playFromHere = useCallback(
    (index: number) => {
      if (tracks.length >= total) {
        playTracks(tracks, index, viewOrigin);
        return;
      }
      void playByFilter({
        q: q || undefined,
        genreId: genreId ?? undefined,
        sort,
        dir,
        start: index,
        origin: viewOrigin,
      }).then((snapshot) => {
        if (snapshot) {
          playSnapshot(snapshot);
          return;
        }
        return fetchAllTracks({
          q: q || undefined,
          genreId: genreId ?? undefined,
          sort,
          dir,
        }).then((full) => {
          const list = full.length > 0 ? full : tracks;
          playTracks(list, Math.min(index, list.length - 1), viewOrigin);
        });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playTracks, playSnapshot, tracks, total, q, genreName, genreId, sort, dir],
  );

  // The row menu's "Play" resolves the same whole view.
  const contextLoader = useCallback(
    () => fetchAllTracks({ q: q || undefined, genreId: genreId ?? undefined, sort, dir }),
    [q, genreId, sort, dir],
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

  // A new ordering or filter is a new list: land at its top, not wherever
  // the old order's scroll offset happens to fall.
  useEffect(() => {
    document.querySelector<HTMLElement>(".shell__canvas")?.scrollTo(0, 0);
  }, [sort, dir, genreId]);

  const onGenre = useCallback(
    (id: number | null) => {
      const next = new URLSearchParams(searchParams);
      if (id == null) next.delete("genre");
      else next.set("genre", String(id));
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Tracks</h1>
          <p className="view__subtitle">
            {/* In flight, an empty fixed-height slot — never a formatted
                zero: a fresh visit (or a genre/filter switch) must not
                flash "0 songs" before the count is measured. */}
            {query.isPending
              ? "\u00A0"
              : genreName
                ? `${fmtCount(total)} ${total === 1 ? "track" : "tracks"} in “${genreName}”`
                : q
                  ? `${fmtCount(total)} ${total === 1 ? "match" : "matches"} for “${q}”`
                  : `${fmtCount(total)} ${total === 1 ? "song" : "songs"}`}
          </p>
        </div>
        <div className="view__actions">
          <GenreMenu value={genreId} onChange={onGenre} />
          <SortMenu
            options={SORT_OPTIONS}
            value={sort}
            dir={dir}
            onChange={(key, nextDir) => onSort(key as TrackSortKey, nextDir)}
            label="Sort tracks"
          />
          <button
            type="button"
            className="view__action"
            onClick={openOrganize}
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
          </button>
        </div>
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
