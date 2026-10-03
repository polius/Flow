import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";

import { api } from "../api/client";
import type { QueueOrigin } from "../api/types";
import {
  useRemoveArtistCover,
  useUpdateArtist,
  useUploadArtistCover,
} from "../api/mutations";
import { AlbumCard } from "../components/AlbumCard";
import { ArtistPortrait } from "../components/ArtistPortrait";
import { CollectionActions } from "../components/CollectionActions";
import { CoverEdit } from "../components/CoverEdit";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconArtists } from "../components/icons";
import { coverChangeNotice, coverRemovalNotice } from "../lib/coverUndo";
import { fmtCount } from "../lib/format";
import { useUiStore } from "../stores/ui";
import { TrackTable } from "../components/TrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
import "../styles/library.css";

/* The song list starts collapsed so the covers stay in charge; it grows
   only on request. */
const COLLAPSED_ROWS = 20;
const COLLAPSE_ABOVE = 30;

export function ArtistDetailView() {
  const artistId = Number(useParams().artistId);
  const [showAll, setShowAll] = useState(false);
  const uploadCover = useUploadArtistCover();
  const removeCover = useRemoveArtistCover();
  const updateArtist = useUpdateArtist();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);

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

  const origin: QueueOrigin = {
    kind: "artist",
    label: artist.name,
    href: `/artists/${artist.id}`,
  };
  const collapsed = !showAll && artist.tracks.length > COLLAPSE_ABOVE;
  const visibleSongs = collapsed
    ? artist.tracks.slice(0, COLLAPSED_ROWS)
    : artist.tracks;

  const removeCoverWithUndo = () => {
    const removed = artist.cover_artwork_id;
    void removeCover(artist.id).then((ok) => {
      if (ok)
        coverRemovalNotice(
          showUndoNotice,
          artist.name,
          removed,
          (id) => updateArtist(artist.id, { cover_artwork_id: id }),
        );
    });
  };

  const onCoverFile = (file: File) => {
    const previous = artist.cover_artwork_id;
    return uploadCover(artist.id, file).then((ok) => {
      if (ok)
        coverChangeNotice(
          showUndoNotice,
          artist.name,
          previous,
          (id) => updateArtist(artist.id, { cover_artwork_id: id }),
        );
    });
  };

  return (
    <section className="view">
      <header className="detailhead">
        <CoverEdit
          round
          hasCover={artist.cover_artwork_id != null}
          onFile={onCoverFile}
          onRemove={removeCoverWithUndo}
        >
          <span className="detailhead__art detailhead__art--round">
            <ArtistPortrait
              artworkId={artist.cover_artwork_id ?? artist.artwork_id}
              name={artist.name}
            />
          </span>
        </CoverEdit>
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
          {/* context stays the WHOLE list, so every visible row plays in the
              artist's full context even while collapsed. */}
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
