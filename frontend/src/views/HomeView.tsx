import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import { playByFilter } from "../api/queue";
import type { QueueOrigin } from "../api/types";
import { AlbumCard } from "../components/AlbumCard";
import { Artwork } from "../components/Artwork";
import { LoadingState } from "../components/LoadingState";
import { FirstRun, FirstScan } from "../components/Onboarding";
import { IconPause, IconPlay, IconShuffle } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { fmtCount, fmtDuration, scanStatusLabel } from "../lib/format";
import { trackIsUnverified, usePlayerStore } from "../stores/player";
import { useScanStore } from "../stores/scan";

/* Its own component so the 4Hz playhead doesn't re-render the whole Home. */
function ContinueListening() {
  const current = usePlayerStore((s) => s.queue[s.order[s.orderPos]] ?? null);
  const upNext = usePlayerStore((s) => s.order.length - s.orderPos - 1);
  const position = usePlayerStore((s) => s.position);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  if (!current) return null;

  const stateBit = isPlaying ? null : `Paused at ${fmtDuration(position)}`;
  const nextBit =
    upNext > 0
      ? `${fmtCount(upNext)} ${upNext === 1 ? "track" : "tracks"} up next`
      : null;

  return (
    <div className="libsection">
      <div className="libsection__head">
        <h2>Continue listening</h2>
      </div>
      <div
        className="continuecard"
        role="button"
        tabIndex={0}
        onClick={togglePlay}
        onKeyDown={(e) => {
          // The artist link owns the keyboard when focused.
          if (e.target instanceof Element && e.target.closest("a")) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            togglePlay();
          }
        }}
        aria-label={`${isPlaying ? "Pause" : "Resume"} ${current.title} — ${
          [current.artist ?? current.album, stateBit, nextBit]
            .filter(Boolean)
            .join(" · ")
        }`}
      >
        <Artwork artworkId={current.artwork_id} size={56} radius="m" />
        <span className="continuecard__meta">
          <span className="continuecard__title">{current.title}</span>
          {(current.artist != null || stateBit != null || nextBit != null) && (
            <span className="continuecard__sub">
              {!trackIsUnverified(current) && current.artist_id != null && current.artist ? (
                // Text, not a link, until the server has vouched for the
                // restored session.
                <Link
                  to={`/artists/${current.artist_id}`}
                  className="continuecard__artistlink"
                  onClick={(e) => e.stopPropagation()}
                >
                  {current.artist}
                </Link>
              ) : (
                (current.artist ?? current.album)
              )}
              {[stateBit, nextBit].filter(Boolean).length > 0 &&
                " · " + [stateBit, nextBit].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        <span className="continuecard__action" aria-hidden="true">
          {isPlaying ? <IconPause size={20} /> : <IconPlay size={20} />}
        </span>
      </div>
    </div>
  );
}

function RecentlyPlayed() {
  const { data } = useQuery({
    queryKey: ["albums", "recently-played"],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { sort: "played", dir: "desc", limit: 12 } },
      });
      return data;
    },
  });
  const albums = (data?.items ?? []).filter((a) => a.played_at != null);
  if (albums.length === 0) return null;
  return (
    <div className="libsection">
      <div className="libsection__head">
        <h2>Recently played</h2>
      </div>
      <div className="covergrid covergrid--home">
        {albums.map((album) => (
          <AlbumCard key={album.id} album={album} />
        ))}
      </div>
    </div>
  );
}

/* The server resolves and shuffles the WHOLE library in one query (never a
   truncated queue); the client-side fetch is the fallback. Shuffle flips on
   before the call so the player bar tells the truth about the plan. */
function ShuffleAll({ count }: { count: number }) {
  const playTracks = usePlayerStore((s) => s.playTracks);
  const playSnapshot = usePlayerStore((s) => s.playSnapshot);
  const [busy, setBusy] = useState(false);

  const shuffleEverything = () => {
    if (busy || count === 0) return;
    setBusy(true);
    const start = Math.floor(Math.random() * count);
    const origin: QueueOrigin = { kind: "shuffle-all", label: "Everything, shuffled" };
    usePlayerStore.getState().setShuffle(true);
    void playByFilter({ sort: "title", dir: "asc", shuffle: true, start, origin })
      .then((snapshot) => {
        if (snapshot) {
          playSnapshot(snapshot);
          return;
        }
        return fetchAllTracks({ sort: "title", dir: "asc" }).then((all) => {
          if (all.length === 0) return;
          playTracks(all, Math.min(start, all.length - 1), origin);
        });
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
    <section className={`view${hasLibrary ? "" : " view--fill"}`}>
      {/* FirstRun / FirstScan carry their own title, so the Home chrome —
          title and subtitle — steps aside when the library is empty. */}
      {hasLibrary && <h1 className="view__title">Home</h1>}
      {hasLibrary &&
        (scanning ? (
          <p className="view__subtitle" aria-live="polite">
            {scan && scanStatusLabel(scan)}
          </p>
        ) : (
          <p className="view__subtitle">{summary}</p>
        ))}

      {hasLibrary && <ContinueListening />}

      {hasLibrary && <RecentlyPlayed />}

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
                {/* The artwrap carries the art→title margin every album-card
                    grid relies on. */}
                <span className="album-card__artwrap">
                  <PlaylistArt
                    artworkIds={playlist.artwork_ids}
                    coverArtworkId={playlist.cover_artwork_id}
                    size={180}
                    radius="m"
                    className="album-card__art"
                  />
                </span>
                <span className="album-card__title">{playlist.name}</span>
                <span className="album-card__meta">
                  {fmtCount(playlist.track_count)} track{playlist.track_count === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {!hasLibrary &&
        (scanning ? (
          <FirstScan scan={scan} />
        ) : settings === undefined ? (
          <LoadingState variant="rows" />
        ) : (
          <FirstRun settings={settings} />
        ))}
    </section>
  );
}