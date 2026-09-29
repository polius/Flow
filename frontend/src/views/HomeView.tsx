import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconMusicNote } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { fmtCount, scanProgressLabel } from "../lib/format";
import { useScanStore } from "../stores/scan";

export function HomeView() {
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data } = await api.GET("/api/settings");
      return data;
    },
  });

  const { data: recent } = useQuery({
    queryKey: ["albums", "recent"],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { sort: "recent", limit: 12 } },
      });
      return data;
    },
  });

  const { data: playlistsData } = useQuery({
    queryKey: ["playlists", "home"],
    queryFn: async () => {
      const { data } = await api.GET("/api/playlists", {
        params: { query: { limit: 12 } },
      });
      return data;
    },
  });

  const counts = settings?.counts;
  const hasLibrary = (counts?.tracks ?? 0) > 0;
  const recentAlbums = recent?.items ?? [];

  const summary = counts
    ? `${fmtCount(counts.tracks)} tracks · ${fmtCount(counts.albums)} albums · ${fmtCount(counts.artists)} artists`
    : null;

  return (
    <section className="view">
      <h1 className="view__title">Home</h1>
      {scanning ? (
        <p className="view__subtitle" aria-live="polite">
          {scan && scanProgressLabel(scan.current, scan.total)}
        </p>
      ) : hasLibrary ? (
        <p className="view__subtitle">{summary}</p>
      ) : null}

      {hasLibrary && recentAlbums.length > 0 && (
        <div className="libsection">
          <div className="libsection__head">
            <h2>Recently added</h2>
            <Link to="/albums" className="libsection__more">
              Show all
            </Link>
          </div>
          <div className="covergrid covergrid--home">
            {recentAlbums.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </div>
      )}

      {hasLibrary && (playlistsData?.items.length ?? 0) > 0 && (
        <div className="libsection">
          <div className="libsection__head">
            <h2>Playlists</h2>
            <Link to="/playlists" className="libsection__more">
              Show all
            </Link>
          </div>
          <div className="covergrid covergrid--home">
            {playlistsData!.items.map((playlist) => (
              <Link key={playlist.id} to={`/playlists/${playlist.id}`} className="album-card">
                <PlaylistArt
                  artworkIds={playlist.artwork_ids}
                  size={180}
                  radius="m"
                  className="album-card__art"
                />
                <span className="album-card__title">{playlist.name}</span>
                <span className="album-card__meta">
                  {fmtCount(playlist.track_count)} track{playlist.track_count === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {!scanning && !hasLibrary &&
        (settings === undefined ? (
          <LoadingState variant="rows" />
        ) : (
          <EmptyState
            icon={<IconMusicNote size={26} />}
            title="Your library is empty"
            hint="Point Flow at your music folder and it will scan, index, and stream it — without ever touching your files."
          />
        ))}
    </section>
  );
}
