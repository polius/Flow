import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { api } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { ArtistPortrait } from "../components/ArtistPortrait";
import { SortMenu, type SortOption } from "../components/SortMenu";
import { IconArtists } from "../components/icons";
import { fmtCount } from "../lib/format";

/* Artists (§9.1 revision): a wall of circular portraits — the Apple-Music
   artist tab grammar. The latest album's cover stands in for the portrait
   (that's the artwork the library has); the absence of one is a quiet
   monogram, not a broken image. Rows became cards because artists are
   browsed by face here, not scanned by name — the detail view is one tap
   away either way. Sort by name, albums, or songs — URL state (?sort=&dir=),
   shared SortMenu grammar: picking the active option flips the direction,
   count sorts read most-first (§2.4). */

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

  const { data } = useQuery({
    queryKey: ["artists", q, sort, dir],
    queryFn: async () => {
      const { data } = await api.GET("/api/artists", {
        params: { query: { limit: 1000, sort, dir, ...(q ? { q } : {}) } },
      });
      return data;
    },
  });

  const artists = data?.items ?? [];
  const total = data?.total ?? 0;

  const onSort = useCallback(
    (key: string, nextDir: "asc" | "desc") => {
      const next = new URLSearchParams(searchParams);
      next.set("sort", key);
      next.set("dir", nextDir);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // A re-sort is a new wall: land at its top (same grammar as Tracks).
  useEffect(() => {
    document.querySelector<HTMLElement>(".shell__canvas")?.scrollTo(0, 0);
  }, [sort, dir]);

  return (
    <section className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">Artists</h1>
          <p className="view__subtitle">
            {q
              ? `${fmtCount(total)} ${total === 1 ? "match" : "matches"} for “${q}”`
              : `${fmtCount(total)} ${total === 1 ? "artist" : "artists"}`}
          </p>
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
      {data === undefined ? (
        <LoadingState variant="rows" />
      ) : artists.length === 0 ? (
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
        <div className="artistgrid">
          {artists.map((artist) => (
            <Link key={artist.id} to={`/artists/${artist.id}`} className="artistcard">
              <span className="artistcard__portrait">
                {/* A user-set portrait (2026-10-03) stands in for the
                    latest album's cover everywhere the artist appears. */}
                <ArtistPortrait
                  artworkId={artist.cover_artwork_id ?? artist.artwork_id}
                  name={artist.name}
                />
              </span>
              <span className="artistcard__name">{artist.name}</span>
              <span className="artistcard__meta">
                {fmtCount(artist.album_count)} album
                {artist.album_count === 1 ? "" : "s"} · {fmtCount(artist.track_count)}{" "}
                song{artist.track_count === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
