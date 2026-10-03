import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";

import { api } from "../api/client";
import type { AlbumDetail } from "../api/types";
import { useReorderTracks } from "../api/mutations";
import { Ambience } from "../components/Ambience";
import { Artwork } from "../components/Artwork";
import { CollectionActions } from "../components/CollectionActions";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconAlbums, IconArtists } from "../components/icons";
import { fmtMinutes } from "../lib/format";
import { TrackTable } from "../components/TrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
import "../styles/library.css";

export function AlbumDetailView() {
  const albumId = Number(useParams().albumId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reorderTracks = useReorderTracks();

  const { data: album } = useQuery({
    queryKey: ["album", albumId],
    queryFn: async () => {
      const { data, response } = await api.GET("/api/albums/{album_id}", {
        params: { path: { album_id: albumId } },
      });
      if (!response.ok) return null;
      return data;
    },
    enabled: Number.isFinite(albumId),
  });

  if (album === null) {
    return (
      <section className="view">
        <EmptyState
          icon={<IconAlbums size={26} />}
          title="Album not found"
          hint="It may have been removed during a library rescan."
        />
      </section>
    );
  }

  if (album === undefined) {
    return (
      <section className="view">
        <LoadingState variant="detail" />
      </section>
    );
  }

  const metaBits = [
    album.artist_id != null ? (
      <Link key="artist" to={`/artists/${album.artist_id}`}>
        {album.artist}
      </Link>
    ) : (
      album.artist
    ),
    album.year != null ? album.year : null,
    `${album.track_count} track${album.track_count === 1 ? "" : "s"}`,
    fmtMinutes(album.duration_total),
  ].filter(Boolean);

  // Drag-to-reorder (2026-10-03): the album joins the playlist and
  // Favorites — the §27 press-and-drag writes the running order. The
  // server renumbers track_no 1..n as overlay edits (POST /api/tracks/
  // reorder), so the guard mirrors that contract: one disc only — a
  // multi-disc album orders by (disc, track) and a cross-disc drag would
  // renumber across the seam the table can't show.
  const discs = new Set(album.tracks.map((t) => t.disc_no ?? 1));
  const reorderable = album.tracks.length > 1 && discs.size === 1;

  const move = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const ids = album.tracks.map((t) => t.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    // Optimistic rewrite of the cached detail — the drag's settle shows the
    // new running order at once, numbers included; the server confirms
    // behind it and the invalidate re-syncs anything it disagrees with.
    queryClient.setQueryData<AlbumDetail>(["album", albumId], {
      ...album,
      tracks: ids.map((id, i) => {
        const row = album.tracks.find((t) => t.id === id)!;
        return { ...row, track_no: i + 1 };
      }),
    });
    void reorderTracks(ids).then((ok) => {
      if (ok) void queryClient.invalidateQueries({ queryKey: ["album", albumId] });
    });
  };

  return (
    <section className="view view--ambient">
      <Ambience artworkId={album.artwork_id} variant="banner" />
      <header className="detailhead">
        <Artwork artworkId={album.artwork_id} size={220} radius="l" className="detailhead__art" />
        <div className="detailhead__info">
          <p className="detailhead__kind">Album</p>
          <h1 className="detailhead__title">{album.title}</h1>
          <p className="detailhead__meta">
            {metaBits.map((bit, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {bit}
              </span>
            ))}
          </p>
          <div className="detailhead__actions">
            <CollectionActions
              tracks={album.tracks}
              label={album.title}
              origin={{ kind: "album", label: album.title, href: `/albums/${album.id}` }}
              extraItems={
                album.artist_id != null
                  ? [
                      // §2.2: the menu answers "where can I go from here" —
                      // the header's artist link is easy to miss; the menu
                      // item is where menus carry it.
                      {
                        label: "Go to Artist",
                        icon: <IconArtists size={15} />,
                        onSelect: () => navigate(`/artists/${album.artist_id}`),
                      },
                    ]
                  : undefined
              }
            />
          </div>
        </div>
      </header>

      <TrackTableHead variant="album" />
      <TrackTable
        tracks={album.tracks}
        variant="album"
        origin={{ kind: "album", label: album.title, href: `/albums/${album.id}` }}
        onMove={reorderable ? move : undefined}
      />
    </section>
  );
}
