import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";

import { api } from "../api/client";
import type { QueueOrigin } from "../api/types";
import { AlbumCard } from "../components/AlbumCard";
import { CollectionActions } from "../components/CollectionActions";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconArtists } from "../components/icons";
import { fmtCount } from "../lib/format";
import { TrackTable } from "../components/TrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
import "../styles/library.css";

/* §1.3's fold: a prolific artist's page keeps its covers in charge — the
   song list starts at COLLAPSED_ROWS rows and only grows on request. */
const COLLAPSED_ROWS = 20;
const COLLAPSE_ABOVE = 30;

export function ArtistDetailView() {
  const artistId = Number(useParams().artistId);
  const [showAll, setShowAll] = useState(false);

  const { data: artist } = useQuery({
    queryKey: ["artist", artistId],
    queryFn: async () => {
      const { data, response } = await api.GET("/api/artists/{artist_id}", {
        params: { path: { artist_id: artistId } },
      });
      if (!response.ok) return null;
      return data;
    },
    enabled: Number.isFinite(artistId),
  });

  if (artist === null) {
    return (
      <section className="view">
        <EmptyState
          icon={<IconArtists size={26} />}
          title="Artist not found"
          hint="They may have been removed during a library rescan."
        />
      </section>
    );
  }

  if (artist === undefined) {
    return (
      <section className="view">
        <LoadingState variant="detail" />
      </section>
    );
  }

  // §1.1: the artist page is the queue's origin here.
  const origin: QueueOrigin = {
    kind: "artist",
    label: artist.name,
    href: `/artists/${artist.id}`,
  };
  const collapsed = !showAll && artist.tracks.length > COLLAPSE_ABOVE;
  const visibleSongs = collapsed
    ? artist.tracks.slice(0, COLLAPSED_ROWS)
    : artist.tracks;

  return (
    <section className="view">
      <header className="detailhead">
        <div className="detailhead__info">
          <p className="detailhead__kind">Artist</p>
          <h1 className="detailhead__title">{artist.name}</h1>
          <p className="detailhead__meta">
            {fmtCount(artist.album_count)} album
            {artist.album_count === 1 ? "" : "s"} · {fmtCount(artist.track_count)} song
            {artist.track_count === 1 ? "" : "s"}
          </p>
          <div className="detailhead__actions">
            <CollectionActions
              tracks={artist.tracks}
              label={`${artist.name}'s songs`}
              origin={origin}
            />
          </div>
        </div>
      </header>

      {artist.albums.length > 0 && (
        <div className="libsection">
          <h2>Albums</h2>
          <div className="covergrid">
            {artist.albums.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </div>
      )}

      {artist.tracks.length > 0 && (
        <div className="libsection">
          <h2>Songs</h2>
          {/* The full credited catalog (§30.3) in the shared TrackRow
              grammar — `context` stays the WHOLE list, so every visible row
              plays in the artist's full context even while collapsed. */}
          <TrackTableHead variant="artist" />
          <TrackTable
            tracks={visibleSongs}
            variant="artist"
            context={artist.tracks}
            origin={origin}
          />
          {collapsed && (
            <button
              type="button"
              className="artist__showall"
              onClick={() => setShowAll(true)}
            >
              Show all {fmtCount(artist.tracks.length)} songs
            </button>
          )}
        </div>
      )}
    </section>
  );
}
