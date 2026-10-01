import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { IconAlbums } from "../components/icons";
import { fmtCount } from "../lib/format";

/* Albums (§2.4): the same URL-state sort grammar as Tracks — Title /
   Artist / Year / Recently added, server-side, shared SortMenu. Picking the
   active option flips the direction; recency reads newest-first. */

const SORT_OPTIONS: SortOption[] = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "year", label: "Year" },
  { key: "recent", label: "Recently added", defaultDir: "desc" },
];

const SORT_KEYS = new Set(SORT_OPTIONS.map((o) => o.key));

export function AlbumsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const urlSort = searchParams.get("sort") ?? "title";
  const sort = SORT_KEYS.has(urlSort) ? urlSort : "title";
  const dir = searchParams.get("dir") === "desc" ? "desc" : "asc";

  const { data } = useQuery({
    queryKey: ["albums", q, sort, dir],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { limit: 1000, sort, dir, ...(q ? { q } : {}) } },
      });
      return data;
    },
  });

  const albums = data?.items ?? [];

  const onSort = useCallback(
    (key: string, nextDir: "asc" | "desc") => {
      const next = new URLSearchParams(searchParams);
      next.set("sort", key);
      next.set("dir", nextDir);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // A new ordering is a new wall: land at its top (same grammar as Tracks).
  useEffect(() => {
    document.querySelector<HTMLElement>(".shell__canvas")?.scrollTo(0, 0);
  }, [sort, dir]);

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Albums</h1>
          <p className="view__subtitle">
            {q
              ? `${fmtCount(albums.length)} ${albums.length === 1 ? "match" : "matches"} for "${q}"`
              : `${fmtCount(albums.length)} ${albums.length === 1 ? "album" : "albums"}`}
          </p>
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
      {data === undefined ? (
        <LoadingState variant="grid" />
      ) : albums.length === 0 ? (
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
        <div className="covergrid">
          {albums.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      )}
    </section>
  );
}
