/* Search — grouped results over one debounced query (§6, §9.2).
   The query lives in the URL so ⌘F lands here and deep links work. */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { api } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { EmptyState } from "../components/EmptyState";
import { IconSearch } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { TrackTable } from "../components/TrackTable";
import { fmtMinutes } from "../lib/format";
import { useUiStore } from "../stores/ui";
import "../styles/library.css";
import "../styles/editing.css";

const DEBOUNCE_MS = 200;

export function SearchView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const [text, setText] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusSignal = useUiStore((s) => s.searchFocusSignal);

  // ⌘F / Ctrl+F from anywhere: AppShell navigates here and bumps the signal.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  // Debounce typing into the URL (the query key).
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = text.trim();
      if (next !== urlQuery) {
        setSearchParams(next ? { q: next } : {}, { replace: true });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text, urlQuery, setSearchParams]);

  // External navigation (back button) updates the field.
  useEffect(() => {
    setText(urlQuery);
  }, [urlQuery]);

  const { data, isFetching } = useQuery({
    queryKey: ["search", urlQuery],
    queryFn: async () => {
      const { data } = await api.GET("/api/search", {
        params: { query: { q: urlQuery } },
      });
      return data;
    },
    enabled: urlQuery.length > 0,
  });

  const hasQuery = urlQuery.trim().length > 0;
  const results = hasQuery ? data : undefined;
  const nothing =
    results != null &&
    results.tracks.length === 0 &&
    results.albums.length === 0 &&
    results.artists.length === 0 &&
    results.playlists.length === 0;

  return (
    <section className="view">
      <h1 className="view__title">Search</h1>
      <div className="searchbar">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          className="searchbar__input"
          type="search"
          placeholder="Artists, albums, tracks, playlists…"
          value={text}
          aria-label="Search library"
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </div>

      {!hasQuery ? (
        <EmptyState
          icon={<IconSearch size={26} />}
          title="Search your library"
          hint="Type to search across tracks, albums, artists, and playlists."
        />
      ) : nothing && !isFetching ? (
        <EmptyState
          icon={<IconSearch size={26} />}
          title={`No results for “${urlQuery}”`}
          hint="Check the spelling, or try a different word."
        />
      ) : results ? (
        <div className="libsection">
          {results.tracks.length > 0 && (
            <>
              <SectionHeader
                title="Tracks"
                more={{ to: `/tracks?q=${encodeURIComponent(urlQuery)}`, label: "Show all in Tracks" }}
              />
              <TrackTable tracks={results.tracks} variant="all" />
            </>
          )}

          {results.albums.length > 0 && (
            <>
              <SectionHeader
                title="Albums"
                more={{ to: `/albums?q=${encodeURIComponent(urlQuery)}`, label: "Show all in Albums" }}
              />
              <div className="covergrid">
                {results.albums.map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </div>
            </>
          )}

          {results.artists.length > 0 && (
            <>
              <SectionHeader
                title="Artists"
                more={{ to: `/artists?q=${encodeURIComponent(urlQuery)}`, label: "Show all in Artists" }}
              />
              <div className="artistlist">
                {results.artists.map((artist) => (
                  <Link key={artist.id} to={`/artists/${artist.id}`} className="artistrow">
                    <span>{artist.name}</span>
                    <span className="artistrow__counts">
                      {artist.album_count} album{artist.album_count === 1 ? "" : "s"} ·{" "}
                      {artist.track_count} song{artist.track_count === 1 ? "" : "s"}
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}

          {results.playlists.length > 0 && (
            <>
              <SectionHeader title="Playlists" />
              <ul className="searchplaylists">
                {results.playlists.map((playlist) => (
                  <li key={playlist.id}>
                    <Link to={`/playlists/${playlist.id}`} className="searchplaylists__row">
                      <PlaylistArt
                        artworkIds={playlist.artwork_ids}
                        coverArtworkId={playlist.cover_artwork_id}
                        size={44}
                        radius="s"
                      />
                      <span className="searchplaylists__name">{playlist.name}</span>
                      <span className="searchplaylists__meta">
                        {playlist.track_count} track{playlist.track_count === 1 ? "" : "s"}
                        {playlist.track_count > 0
                          ? ` · ${fmtMinutes(playlist.duration_total)}`
                          : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SectionHeader({
  title,
  more,
}: {
  title: string;
  more?: { to: string; label: string };
}) {
  return (
    <div className="libsection__head">
      <h2>{title}</h2>
      {more && (
        <Link to={more.to} className="libsection__more">
          {more.label}
        </Link>
      )}
    </div>
  );
}
