import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { api } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LetterRail } from "../components/LetterRail";
import { LoadingState } from "../components/LoadingState";
import { VirtualCardGrid } from "../components/VirtualCardGrid";
import { ArtistPortrait } from "../components/ArtistPortrait";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { IconArtists } from "../components/icons";
import { fmtCount } from "../lib/format";
import { useMediaQuery } from "../lib/media";
import { usePagedList } from "../lib/pagedList";
import { useCanvasTopOnChange } from "../lib/scroll";

/* Read in pages where the window is, like Albums: the wall is as long as
   the library, not as long as one request. */
const PAGE_SIZE = 500;
/** A card is its square art plus this much text below it (the name and the count line):
    with the exact figure the grid's height is right before a row is ever
    measured, and nothing shifts as rows scroll in. */
const CARD_TEXT_HEIGHT = 49.7;

const SORT_OPTIONS: SortOption[] = [
  { key: "name", label: "Name" },
  { key: "albums", label: "Albums", defaultDir: "desc" },
  { key: "songs", label: "Songs", defaultDir: "desc" },
];

const SORT_KEYS = new Set(SORT_OPTIONS.map((o) => o.key));

export function ArtistsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const urlSort = searchParams.get("sort") ?? "name";
  const sort = SORT_KEYS.has(urlSort) ? urlSort : "name";
  const dir = searchParams.get("dir") === "desc" ? "desc" : "asc";

  const list = usePagedList(["artists", q, sort, dir], PAGE_SIZE, async (offset, limit) => {
    const { data } = await api.GET("/api/artists", {
      params: { query: { limit, offset, sort, dir, ...(q ? { q } : {}) } },
    });
    return data;
  });
  const total = list.total ?? 0;
  // The grid's numbers, as library.css had them for .artistgrid.
  const phone = useMediaQuery("(max-width: 640px)");

  // The A to Z rail, for the one sort an alphabet indexes.
  const { data: letters } = useQuery({
    queryKey: ["artists", "letters", q, dir],
    queryFn: async () => {
      const { data } = await api.GET("/api/letters", {
        params: { query: { of: "artists", dir, ...(q ? { q } : {}) } },
      });
      return data;
    },
    enabled: sort === "name",
  });
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);
  const railLetters = sort === "name" ? (letters?.letters ?? []) : [];
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

  // A re-sort is a new wall: land at its top.
  useCanvasTopOnChange(sort, dir);

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Artists</h1>
          {list.total !== undefined && (
            <p className="view__subtitle">
              {q
                ? `${fmtCount(total)} ${total === 1 ? "match" : "matches"} for “${q}”`
                : `${fmtCount(total)} ${total === 1 ? "artist" : "artists"}`}
            </p>
          )}
        </div>
        <div className="view__actions">
          <SortMenu
            options={SORT_OPTIONS}
            value={sort}
            dir={dir}
            onChange={onSort}
            label="Sort artists"
          />
        </div>
      </div>
      {list.isError ? (
        <ErrorState what="artists" retry={list.refetch} />
      ) : list.total === undefined ? (
        <LoadingState variant="rows" />
      ) : total === 0 ? (
        <EmptyState
          icon={<IconArtists size={26} />}
          title={q ? `No artists match “${q}”` : "No artists yet"}
          hint={
            q
              ? "Try a different word, or search everything from the Search view."
              : "Artists appear here once the library has been scanned."
          }
        />
      ) : (
        <>
          <VirtualCardGrid
            className="cardgrid--artists"
            count={total}
            minColumn={phone ? 88 : 104}
            columnGap={phone ? 14 : 20}
            rowGap={phone ? 22 : 28}
            cardExtra={CARD_TEXT_HEIGHT}
            onRangeChange={list.ensure}
            jump={jump}
            renderCard={(index) => {
              const artist = list.items[index];
              if (!artist)
                return (
                  <div key={`loading-${index}`} className="artistcard" aria-hidden="true">
                    <span className="artistcard__portrait skeleton" />
                  </div>
                );
              return (
                <Link key={artist.id} to={`/artists/${artist.id}`} className="artistcard">
                  <span className="artistcard__portrait">
                    <ArtistPortrait
                      artworkId={artist.cover_artwork_id ?? artist.artwork_id}
                      name={artist.name}
                    />
                  </span>
                  <span className="artistcard__name">{artist.name}</span>
                  <span className="artistcard__meta">
                    {fmtCount(artist.album_count)} album
                    {artist.album_count === 1 ? "" : "s"}
                    {/* Phones have room for the first count only: with both,
                        every card ended in "29 so…". */}
                    <span className="artistcard__songs">
                      {" "}
                      · {fmtCount(artist.track_count)} song{artist.track_count === 1 ? "" : "s"}
                    </span>
                  </span>
                </Link>
              );
            }}
          />
          {railed && (
            <LetterRail
              label="Artists"
              letters={railLetters}
              onJump={(index) => setJump((cur) => ({ index, nonce: (cur?.nonce ?? 0) + 1 }))}
            />
          )}
        </>
      )}
    </section>
  );
}
