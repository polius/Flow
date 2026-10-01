import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import { AlbumCard } from "../components/AlbumCard";
import { Artwork } from "../components/Artwork";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconMusicNote, IconPause, IconPlay, IconShuffle } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { fmtCount, fmtDuration, scanPhaseLabel, scanProgressLabel } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { useScanStore } from "../stores/scan";

/* Continue listening (§13.9, §29): the session the app restored — current
   track, where it paused, how much of the queue is still ahead. One quiet
   row; activating it resumes at the saved position (the first play loads
   the restored track into the element, paused up to now). Subscribed from
   its own component so the 4Hz playhead doesn't re-render the whole Home. */
function ContinueListening() {
  const current = usePlayerStore((s) => s.queue[s.order[s.orderPos]] ?? null);
  const upNext = usePlayerStore((s) => s.order.length - s.orderPos - 1);
  const position = usePlayerStore((s) => s.position);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  if (!current) return null;

  const meta = [
    current.artist ?? current.album ?? null,
    isPlaying ? null : `Paused at ${fmtDuration(position)}`,
    upNext > 0
      ? `${fmtCount(upNext)} ${upNext === 1 ? "track" : "tracks"} up next`
      : null,
  ].filter(Boolean);

  return (
    <div className="libsection">
      <div className="libsection__head">
        <h2>Continue listening</h2>
      </div>
      <button
        type="button"
        className="continuecard"
        onClick={togglePlay}
        aria-label={`${isPlaying ? "Pause" : "Resume"} ${current.title}${
          meta.length > 0 ? ` — ${meta.join(" · ")}` : ""
        }`}
      >
        <Artwork artworkId={current.artwork_id} size={56} radius="m" />
        <span className="continuecard__meta">
          <span className="continuecard__title">{current.title}</span>
          {meta.length > 0 && (
            <span className="continuecard__sub">{meta.join(" · ")}</span>
          )}
        </span>
        <span className="continuecard__action" aria-hidden="true">
          {isPlaying ? <IconPause size={13} /> : <IconPlay size={13} />}
        </span>
      </button>
    </div>
  );
}

/* Shuffle all (§2.5): the escape hatch. One card, whole library, shuffled —
   "play something" answered without deciding anything. Fetches the full
   library before queuing (§29: never a truncated queue), then flips shuffle
   on so the plan is honest in the player bar. */
function ShuffleAll({ count }: { count: number }) {
  const playTracks = usePlayerStore((s) => s.playTracks);
  const [busy, setBusy] = useState(false);

  const shuffleEverything = () => {
    if (busy || count === 0) return;
    setBusy(true);
    void fetchAllTracks({ sort: "title", dir: "asc" })
      .then((all) => {
        if (all.length === 0) return;
        const start = Math.floor(Math.random() * all.length);
        usePlayerStore.getState().setShuffle(true);
        playTracks(all, start);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="libsection">
      <div className="libsection__head">
        <h2>Shuffle all</h2>
      </div>
      <button
        type="button"
        className="shufflecard"
        onClick={shuffleEverything}
        disabled={busy}
        aria-label={`Shuffle all ${fmtCount(count)} tracks`}
      >
        <span className="shufflecard__tile" aria-hidden="true">
          <IconShuffle size={20} />
        </span>
        <span className="shufflecard__meta">
          <span className="shufflecard__title">{busy ? "Shuffling…" : "Everything, shuffled"}</span>
          <span className="shufflecard__sub">
            {fmtCount(count)} tracks · the whole library, in random order
          </span>
        </span>
      </button>
    </div>
  );
}

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
          {scan &&
            (scanPhaseLabel(scan.phase) ?? scanProgressLabel(scan.current, scan.total))}
        </p>
      ) : hasLibrary ? (
        <p className="view__subtitle">{summary}</p>
      ) : null}

      {hasLibrary && <ContinueListening />}

      {hasLibrary && counts && counts.tracks > 0 && (
        <ShuffleAll count={counts.tracks} />
      )}

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
