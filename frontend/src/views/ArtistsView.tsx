import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { api } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconArtists, IconCheck } from "../components/icons";
import { fmtCount } from "../lib/format";

/* Artists (§9.1 revision): a wall of circular portraits — the Apple-Music
   artist tab grammar. The latest album's cover stands in for the portrait
   (that's the artwork the library has); the absence of one is a quiet
   monogram, not a broken image. Rows became cards because artists are
   browsed by face here, not scanned by name — the detail view is one tap
   away either way. Sort by name, albums, or songs (URL state). */

const SORTS = [
  { key: "name", label: "Name" },
  { key: "albums", label: "Albums" },
  { key: "songs", label: "Songs" },
] as const;

export function ArtistsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const urlSort = searchParams.get("sort") ?? "name";
  const sort = (SORTS.some((s) => s.key === urlSort) ? urlSort : "name") as
    | "name"
    | "albums"
    | "songs";
  const [menuOpen, setMenuOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["artists", q, sort],
    queryFn: async () => {
      const { data } = await api.GET("/api/artists", {
        params: { query: { limit: 1000, sort, ...(q ? { q } : {}) } },
      });
      return data;
    },
  });

  const artists = data?.items ?? [];
  const total = data?.total ?? 0;

  const pick = useCallback(
    (key: "name" | "albums" | "songs") => {
      const next = new URLSearchParams(searchParams);
      next.set("sort", key);
      setSearchParams(next, { replace: true });
      setMenuOpen(false);
    },
    [searchParams, setSearchParams],
  );

  // The sort menu closes on outside tap and Esc, like every other menu.
  const sortRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (sortRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

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
        <div ref={sortRef}>
          <SortPill
            open={menuOpen}
            setOpen={setMenuOpen}
            sort={sort}
            onPick={pick}
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
                <ArtistPortrait artworkId={artist.artwork_id} name={artist.name} />
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

/* The portrait: artwork cropped to a circle, or a monogram when the artist
   has no cover — or the cover is broken (demo libraries happen; the img
   element's error is a designed state, not a glyph). */
export function ArtistPortrait({
  artworkId,
  name,
}: {
  artworkId: number | null | undefined;
  name: string;
}): ReactNode {
  const [failed, setFailed] = useState(false);
  if (artworkId == null || failed) {
    return (
      <span className="artistcard__monogram" aria-hidden="true">
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="artistcard__img"
      src={`/api/artwork/${artworkId}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function SortPill({
  open,
  setOpen,
  sort,
  onPick,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  sort: "name" | "albums" | "songs";
  onPick: (key: "name" | "albums" | "songs") => void;
}) {
  return (
    <div className="artistsort">
      <button
        type="button"
        className="view__action"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {SORTS.find((s) => s.key === sort)?.label ?? "Sort"}
      </button>
      {open && (
        <div className="trackmenu artistsort__pop" role="menu" aria-label="Sort artists">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="menuitemradio"
              aria-checked={s.key === sort}
              className="trackmenu__item"
              onClick={() => onPick(s.key)}
            >
              <span className="trackmenu__check" aria-hidden="true">
                {s.key === sort && <IconCheck size={13} />}
              </span>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
