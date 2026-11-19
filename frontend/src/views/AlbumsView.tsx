import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LetterRail } from "../components/LetterRail";
import { LoadingState } from "../components/LoadingState";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { VirtualCardGrid } from "../components/VirtualCardGrid";
import { IconAlbums } from "../components/icons";
import { fmtCount } from "../lib/format";
import { useMediaQuery } from "../lib/media";
import { usePagedList } from "../lib/pagedList";
import { useCanvasTopOnChange } from "../lib/scroll";

/* The grid is sized to the whole library from the first answer; pages of
   albums are read where the window is. (One request for "the first 1,000"
   used to be the whole grid: a library with more showed 1,000, said
   "1,000 albums", and could not reach the rest.) */
const PAGE_SIZE = 500;
/** A card is its square art plus this much text below it (the title and the artist line):
    with the exact figure the grid's height is right before a row is ever
    measured, and nothing shifts as rows scroll in. */
const CARD_TEXT_HEIGHT = 49.7;

const SORT_OPTIONS: SortOption[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "year", label: "Year" },
  { key: "recent", label: "Recently added", defaultDir: "desc" },
  { key: "played", label: "Recently played", defaultDir: "desc" },
];

const SORT_KEYS = new Set(SORT_OPTIONS.map((o) => o.key));

export function AlbumsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const urlSort = searchParams.get("sort") ?? "title";
  const sort = SORT_KEYS.has(urlSort) ? urlSort : "title";
  const dir = searchParams.get("dir") === "desc" ? "desc" : "asc";

  const list = usePagedList(["albums", q, sort, dir], PAGE_SIZE, async (offset, limit) => {
    const { data } = await api.GET("/api/albums", {
      params: { query: { limit, offset, sort, dir, ...(q ? { q } : {}) } },
    });
    return data;
  });
  const total = list.total ?? 0;
  // Phones: two albums a row, like Playlists, never one full-width cover.
  // 124px rather than Playlists' 132px: the A to Z rail's wider right
  // padding leaves 274px at 320px, and two columns must still fit there.
  // Three from about 460px.
  const phone = useMediaQuery("(max-width: 640px)");

  // The A to Z rail, for the one sort an alphabet indexes.
  const { data: letters } = useQuery({
    queryKey: ["albums", "letters", q, dir],
    queryFn: async () => {
      const { data } = await api.GET("/api/letters", {
        params: { query: { of: "albums", dir, ...(q ? { q } : {}) } },
      });
      return data;
    },
    enabled: sort === "title",
  });
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);
  const railLetters = sort === "title" ? (letters?.letters ?? []) : [];
  const railed = railLetters.length > 1;

  const onSort = useCallback(
    (key: string, nextDir: "asc" | "desc") => {
      const next = new URLSearchParams(searchParams);
      next.set("sort", key);
      next.set("dir", nextDir);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // A new ordering is a new wall: land at its top.
  useCanvasTopOnChange(sort, dir);

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Albums</h1>
          {/* No count until there is one: a failed load is not "0 albums". */}
          {list.total !== undefined && (
            <p className="view__subtitle">
              {q
                ? `${fmtCount(total)} ${total === 1 ? "match" : "matches"} for “${q}”`
                : `${fmtCount(total)} ${total === 1 ? "album" : "albums"}`}
            </p>
          )}
        </div>
        <div className="view__actions">
          <SortMenu
            options={SORT_OPTIONS}
            value={sort}
            dir={dir}
            onChange={onSort}
            label="Sort albums"
          />
        </div>
      </div>
      {list.isError ? (
        <ErrorState what="albums" retry={list.refetch} />
      ) : list.total === undefined ? (
        <LoadingState variant="grid" />
      ) : total === 0 ? (
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
        <>
          <VirtualCardGrid
            count={total}
            minColumn={phone ? 124 : 168}
            columnGap={20}
            rowGap={24}
            cardExtra={CARD_TEXT_HEIGHT}
            onRangeChange={list.ensure}
            jump={jump}
            renderCard={(index) => {
              const album = list.items[index];
              return album ? (
                <AlbumCard key={album.id} album={album} />
              ) : (
                <div key={`loading-${index}`} className="loading-card" aria-hidden="true">
                  <div className="skeleton skeleton--square" />
                  <div className="skeleton skeleton--line" style={{ width: "72%" }} />
                  <div className="skeleton skeleton--line skeleton--thin" style={{ width: "46%" }} />
                </div>
              );
            }}
          />
          {railed && (
            <LetterRail
              label="Albums"
              letters={railLetters}
              onJump={(index) => setJump((cur) => ({ index, nonce: (cur?.nonce ?? 0) + 1 }))}
            />
          )}
        </>
      )}
    </section>
  );
}
