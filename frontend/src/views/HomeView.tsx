import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { api, fetchAllTracks } from "../api/client";
import { settingsQuery } from "../api/system";
import { playByFilter } from "../api/queue";
import type { QueueOrigin } from "../api/types";
import { AlbumCard } from "../components/AlbumCard";
import { Artwork } from "../components/Artwork";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { FirstRun, FirstScan } from "../components/Onboarding";
import { IconChevronDown, IconPause, IconPlay, IconShuffle } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { fmtCount, fmtDuration, scanStatusLabel } from "../lib/format";
import { beginPlayRequest, trackIsUnverified, usePlayerStore } from "../stores/player";
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
      ? `${fmtCount(upNext)} ${upNext === 1 ? "song" : "songs"} up next`
      : null;

  // The link in the second line may only be offered once the server has
  // vouched for the restored session.
  const artistLink =
    !trackIsUnverified(current) && current.artist_id != null && current.artist ? (
      <Link to={`/artists/${current.artist_id}`} className="continuecard__artistlink">
        {current.artist}
      </Link>
    ) : (
      (current.artist ?? current.album)
    );
  const tail = [stateBit, nextBit].filter(Boolean);

  return (
    <div className="homehero__item">
      <h2 className="homehero__title">Continue listening</h2>
      {/* The card is one button (play or pause) and, laid over its second
          line, the artist link as a sibling — a link inside a button is a
          control inside a control, which assistive technology cannot
          reach. The button's name is the title it shows. */}
      <div className="continuecard">
        <button
          type="button"
          className="continuecard__button"
          onClick={togglePlay}
          aria-describedby="continue-sub"
        >
          <Artwork artworkId={current.artwork_id} size={56} radius="m" />
          <span className="continuecard__meta">
            <span className="continuecard__title">
              {current.title}
              <span className="sr-only">{isPlaying ? ", pause" : ", resume"}</span>
            </span>
            {/* Holds the second line's place; the line itself sits on top. */}
            <span className="continuecard__subspace" aria-hidden="true" />
          </span>
          <span className="continuecard__action" aria-hidden="true">
            {isPlaying ? <IconPause size={20} /> : <IconPlay size={20} />}
          </span>
        </button>
        <span className="continuecard__sub" id="continue-sub">
          {artistLink}
          {tail.length > 0 && (artistLink ? " · " : "") + tail.join(" · ")}
        </span>
      </div>
    </div>
  );
}

/* One Home shelf: a titled, horizontally scrolling row of cards (a wrapping
   grid on phones, where touch swipes it). A mouse has no horizontal wheel
   and the scrollbars stay invisible until hovered, so on devices with
   hover the head carries ‹ › buttons that page the row; each disables at
   its end. */
function Shelf({
  title,
  more,
  children,
}: {
  title: string;
  more?: { to: string; label: string };
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const page = (dir: 1 | -1) => {
    const el = rowRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section className="libsection" aria-label={title}>
      <div className="libsection__head">
        <h2>{title}</h2>
        <div className="libsection__tail">
          {more && (
            <Link to={more.to} className="libsection__more">
              {more.label}
            </Link>
          )}
          {!(edges.start && edges.end) && (
            <span className="shelf__nav">
              <button
                type="button"
                className="shelf__btn"
                aria-label={`Scroll ${title} back`}
                disabled={edges.start}
                onClick={() => page(-1)}
              >
                <IconChevronDown size={14} className="shelf__chev shelf__chev--back" />
              </button>
              <button
                type="button"
                className="shelf__btn"
                aria-label={`Scroll ${title} forward`}
                disabled={edges.end}
                onClick={() => page(1)}
              >
                <IconChevronDown size={14} className="shelf__chev shelf__chev--fwd" />
              </button>
            </span>
          )}
        </div>
      </div>
      <div ref={rowRef} className="covergrid covergrid--home" onScroll={measure}>
        {children}
      </div>
    </section>
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
    <Shelf title="Recently played">
      {albums.map((album) => (
        <AlbumCard key={album.id} album={album} />
      ))}
    </Shelf>
  );
}

/* The albums played most, by counted plays (30 s or half a song each).
   Shown once the history has something to say: ten plays. */
const MOST_PLAYED_AFTER = 10;

function MostPlayed() {
  const { data } = useQuery({
    queryKey: ["albums", "most-played"],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { sort: "plays", dir: "desc", limit: 12 } },
      });
      return data;
    },
  });
  // A played album has a played_at; one never played sorts last anyway.
  const albums = (data?.items ?? []).filter((a) => a.played_at != null);
  if (albums.length === 0) return null;
  return (
    <Shelf title="Most played">
      {albums.map((album) => (
        <AlbumCard key={album.id} album={album} />
      ))}
    </Shelf>
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
    // A newer play started while the server shuffles wins.
    const isCurrent = beginPlayRequest();
    void playByFilter({ sort: "title", dir: "asc", shuffle: true, start, origin })
      .then((snapshot) => {
        if (!isCurrent()) return;
        if (snapshot) {
          playSnapshot(snapshot);
          return;
        }
        return fetchAllTracks({ sort: "title", dir: "asc" }).then((all) => {
          if (all.length === 0 || !isCurrent()) return;
          playTracks(all, Math.min(start, all.length - 1), origin);
        });
      })
      .finally(() => setBusy(false));
  };

  // The installed app's "Shuffle everything" shortcut opens /?start=shuffle.
  const [params, setParams] = useSearchParams();
  const fromShortcut = params.get("start") === "shuffle";
  useEffect(() => {
    if (!fromShortcut || count === 0) return;
    // After the render, and once: the cleanup cancels a second arrival
    // (StrictMode), and dropping the parameter ends the first.
    const timer = window.setTimeout(() => {
      setParams({}, { replace: true });
      shuffleEverything();
    }, 0);
    return () => window.clearTimeout(timer);
    // shuffleEverything is a fresh function each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromShortcut, count]);

  return (
    <div className="homehero__item">
      {/* Named by what it shows: no aria-label to drift from the words. */}
      <button type="button" className="shufflecard" onClick={shuffleEverything} disabled={busy}>
        <span className="shufflecard__tile" aria-hidden="true">
          <IconShuffle size={20} />
        </span>
        <span className="shufflecard__meta">
          <span className="shufflecard__title">{busy ? "Shuffling…" : "Shuffle all"}</span>
          <span className="shufflecard__sub">
            {fmtCount(count)} {count === 1 ? "song" : "songs"}, in random order
          </span>
        </span>
      </button>
    </div>
  );
}

/* Albums that have gone quiet: last played more than six months ago, or
   never. Offered only once the library has a listening record at all —
   on a fresh library every album is "never played", and the shelf would
   just be the first twelve. */
const LATELY_MS = 183 * 24 * 60 * 60 * 1000;

function NotPlayedLately() {
  const { data } = useQuery({
    queryKey: ["albums", "not-played-lately"],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        // Ascending by last play: never-played first, then the oldest.
        params: { query: { sort: "played", dir: "asc", limit: 12 } },
      });
      return data;
    },
  });
  const { data: played } = useQuery({
    queryKey: ["albums", "recently-played"],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { sort: "played", dir: "desc", limit: 12 } },
      });
      return data;
    },
  });
  const hasRecord = (played?.items ?? []).some((a) => a.played_at != null);
  const [cutoff] = useState(() => Date.now() - LATELY_MS);
  const albums = (data?.items ?? []).filter(
    (a) => a.played_at == null || new Date(a.played_at).getTime() < cutoff,
  );
  if (!hasRecord || albums.length === 0) return null;
  return (
    <Shelf title="Not played lately">
      {albums.map((album) => (
        <AlbumCard key={album.id} album={album} />
      ))}
    </Shelf>
  );
}

/* The first favorites, in the order Favorites keeps them. A card plays the
   whole of Favorites from that song. */
function FavoritesShelf() {
  const playSnapshot = usePlayerStore((s) => s.playSnapshot);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const { data } = useQuery({
    queryKey: ["tracks", "favorites", "home"],
    queryFn: async () => {
      const { data } = await api.GET("/api/tracks", {
        params: { query: { favorite: true, sort: "favorite", dir: "asc", limit: 12 } },
      });
      return data;
    },
  });
  const tracks = data?.items ?? [];
  if (tracks.length === 0) return null;

  const origin: QueueOrigin = { kind: "filter", label: "Favorites", href: "/favorites" };
  const play = (index: number) => {
    if (tracks.length >= (data?.total ?? 0)) {
      playTracks(tracks, index, origin);
      return;
    }
    // More favorites than the shelf shows: the server resolves them all.
    const isCurrent = beginPlayRequest();
    void playByFilter({ favorite: true, sort: "favorite", dir: "asc", start: index, origin }).then(
      (snapshot) => {
        if (!isCurrent()) return;
        if (snapshot) playSnapshot(snapshot);
        else playTracks(tracks, index, origin);
      },
    );
  };

  return (
    <Shelf title="Favorites" more={{ to: "/favorites", label: "Show all" }}>
      {tracks.map((track, index) => (
        <button
          key={track.id}
          type="button"
          className="album-card album-card--song"
          onClick={() => play(index)}
        >
          <span className="album-card__artwrap">
            <Artwork artworkId={track.artwork_id} size={180} radius="m" className="album-card__art" />
          </span>
          <span className="album-card__title">{track.title}</span>
          <span className="album-card__meta">{track.artist ?? "Unknown artist"}</span>
        </button>
      ))}
    </Shelf>
  );
}

export function HomeView() {
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";

  const {
    data: settings,
    isError: settingsFailed,
    refetch: refetchSettings,
  } = useQuery(settingsQuery);

  const { data: recent } = useQuery({
    queryKey: ["albums", "recent"],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums", {
        params: { query: { sort: "recent", dir: "desc", limit: 12 } },
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
    ? `${fmtCount(counts.tracks)} ${counts.tracks === 1 ? "song" : "songs"} · ${fmtCount(counts.albums)} ${counts.albums === 1 ? "album" : "albums"} · ${fmtCount(counts.artists)} ${counts.artists === 1 ? "artist" : "artists"}`
    : null;

  return (
    <section className={`view${hasLibrary ? "" : " view--fill"}`}>
      {/* FirstRun / FirstScan carry their own h1, so the Home chrome —
          title and subtitle — steps aside when the library is empty. */}
      {hasLibrary && <h1 className="view__title">Home</h1>}
      {hasLibrary && (
        // Visual progress only: the shell's Announcer speaks the scan's
        // start and end, never each tick.
        <p className="view__subtitle">{scanning && scan ? scanStatusLabel(scan) : summary}</p>
      )}

      {/* Resume and shuffle share one row: stacked, each was a narrow card
          under its own heading and half the first screen was empty. */}
      {hasLibrary && counts && (
        <div className="homehero">
          <ContinueListening />
          <ShuffleAll count={counts.tracks} />
        </div>
      )}

      {hasLibrary && <RecentlyPlayed />}

      {hasLibrary && (counts?.plays ?? 0) >= MOST_PLAYED_AFTER && <MostPlayed />}

      {hasLibrary && recentAlbums.length > 0 && (
        // "Show all" keeps the shelf's order: Albums opens sorted by
        // recently added, not by title.
        <Shelf
          title="Recently added"
          more={{ to: "/albums?sort=recent&dir=desc", label: "Show all" }}
        >
          {recentAlbums.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </Shelf>
      )}

      {hasLibrary && <FavoritesShelf />}

      {hasLibrary && <NotPlayedLately />}

      {hasLibrary && (playlistsData?.items.length ?? 0) > 0 && (
        <Shelf title="Playlists" more={{ to: "/playlists", label: "Show all" }}>
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
                {fmtCount(playlist.track_count)} song{playlist.track_count === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </Shelf>
      )}

      {!hasLibrary &&
        (scanning ? (
          <FirstScan scan={scan} />
        ) : settings === undefined && settingsFailed ? (
          <ErrorState what="your library" retry={refetchSettings} />
        ) : settings === undefined ? (
          <LoadingState variant="rows" />
        ) : (
          <FirstRun settings={settings} />
        ))}
    </section>
  );
}