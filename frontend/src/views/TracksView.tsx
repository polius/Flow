import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import { playByFilter } from "../api/queue";
import type { QueueOrigin, Track } from "../api/types";
import { GenreMenu } from "../components/GenreMenu";
import { LetterRail } from "../components/LetterRail";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { TrackTableHead, type TrackSortKey } from "../components/TrackTableHead";
import { VirtualTrackTable } from "../components/VirtualTrackTable";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { useReviewCount } from "../components/ReviewStrip";
import { IconOrganize, IconTracks } from "../components/icons";
import { fmtCount } from "../lib/format";
import { usePagedList } from "../lib/pagedList";
import { useCanvasTopOnChange } from "../lib/scroll";
import { beginPlayRequest, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

/* Full-library view, windowed. The list is sized to the whole library
   from the first answer, and pages of 500 are read where the window is —
   the end of 50,000 songs is one scroll away, not fifty. */
const PAGE_SIZE = 500;

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

  const query = usePagedList(
    ["tracks", "all", q, sort, dir, genreId],
    PAGE_SIZE,
    async (offset, limit) => {
      const { data } = await api.GET("/api/tracks", {
        params: {
          query: {
            limit,
            offset,
            sort,
            dir,
            ...(q ? { q } : {}),
            ...(genreId != null ? { genre_id: genreId } : {}),
          },
        },
      });
      return data;
    },
  );

  const tracks = query.items;
  const total = query.total ?? 0;
  // Every row is here: the list can be played (and counted) locally.
  const allLoaded = query.total !== undefined && query.loaded >= total;

  // The A to Z rail, for the one sort an alphabet indexes.
  const { data: letters } = useQuery({
    queryKey: ["tracks", "letters", q, dir, genreId],
    queryFn: async () => {
      const { data } = await api.GET("/api/letters", {
        params: {
          query: {
            of: "tracks",
            dir,
            ...(q ? { q } : {}),
            ...(genreId != null ? { genre_id: genreId } : {}),
          },
        },
      });
      return data;
    },
    enabled: sort === "title",
  });
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);
  const railLetters = sort === "title" ? (letters?.letters ?? []) : [];
  const railed = railLetters.length > 1;

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
  // The row menu's "Play" runs this same path (one request, not a
  // page-by-page fetch). A slow request that a newer play overtook is
  // dropped — it must not replace the queue the user started since.
  const playFromHere = useCallback(
    (index: number) => {
      if (allLoaded) {
        playTracks(tracks as Track[], index, viewOrigin);
        return;
      }
      const isCurrent = beginPlayRequest();
      void playByFilter({
        q: q || undefined,
        genreId: genreId ?? undefined,
        sort,
        dir,
        start: index,
        origin: viewOrigin,
      }).then((snapshot) => {
        if (!isCurrent()) return;
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
          if (!isCurrent()) return;
          // Last resort: whatever rows did load, from the one asked for.
          const loadedRows = tracks.filter((t): t is Track => t != null);
          const list = full.length > 0 ? full : loadedRows;
          const at = full.length > 0 ? index : loadedRows.indexOf(tracks[index] as Track);
          playTracks(list, Math.max(0, Math.min(at, list.length - 1)), viewOrigin);
        });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playTracks, playSnapshot, tracks, allLoaded, q, genreName, genreId, sort, dir],
  );

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
  useCanvasTopOnChange(sort, dir, genreId);

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
            {query.total === undefined
              ? "\u00A0"
              : genreName
                ? `${fmtCount(total)} ${total === 1 ? "song" : "songs"} in “${genreName}”`
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
            label="Sort songs"
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
      {query.isError ? (
        <ErrorState what="your songs" retry={query.refetch} />
      ) : query.total === undefined ? (
        <LoadingState variant="rows" />
      ) : total === 0 ? (
        <EmptyState
          icon={<IconTracks size={26} />}
          title={q ? `No songs match “${q}”` : "No songs yet"}
          hint={
            q
              ? "Try a different word, or search everything from the Search view."
              : "Every song in your library will live here, in a table built to stay smooth at ten thousand tracks."
          }
        />
      ) : (
        <>
          <VirtualTrackTable
            head={<TrackTableHead sort={sort} dir={dir} onSort={onSort} />}
            label={genreName ? `Songs in ${genreName}` : q ? `Songs matching “${q}”` : "All songs"}
            tracks={tracks}
            onRangeChange={query.ensure}
            jump={jump}
            onPlay={playFromHere}
          />
          {railed && (
            <LetterRail
              label="Songs"
              letters={railLetters}
              onJump={(index) => setJump((cur) => ({ index, nonce: (cur?.nonce ?? 0) + 1 }))}
            />
          )}
        </>
      )}
    </section>
  );
}
