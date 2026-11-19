import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "../api/client";
import type { PlaylistSummary, QueueOrigin } from "../api/types";
import {
  useDeletePlaylist,
} from "../api/mutations";
import { CardMenu } from "../components/CardMenu";
import { inCardSheet, useCardLongPress } from "../lib/cardMenu";
import { CreatePlaylistDialog } from "../components/CreatePlaylistDialog";
import { AddTracksDialog } from "../components/LazyAddTracksDialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import {
  IconEllipsis,
  IconHeartFill,
  IconNext,
  IconPlay,
  IconPlaylists,
  IconPlus,
  IconQueue,
  IconShuffle,
  IconTrash,
} from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { fmtCount, fmtMinutes } from "../lib/format";
import { beginPlayRequest, usePlayerStore } from "../stores/player";
import "../styles/library.css";
import "../styles/editing.css";

export function PlaylistsView() {
  const [creating, setCreating] = useState(false);

  const { data, isError, refetch } = useQuery({
    queryKey: ["playlists"],
    queryFn: async () => {
      const { data } = await api.GET("/api/playlists", { params: { query: { limit: 1000 } } });
      return data;
    },
  });

  const playlists = data?.items ?? [];

  return (
    <section className="view">
      <header className="view__head">
        <div>
          <h1 className="view__title">Playlists</h1>
          {data !== undefined && (
            <p className="view__subtitle">
              {fmtCount(playlists.length)} {playlists.length === 1 ? "playlist" : "playlists"}
            </p>
          )}
        </div>
        <button
          type="button"
          className="view__action"
          onClick={() => setCreating(true)}
        >
          New Playlist
        </button>
      </header>

      {creating && <CreatePlaylistDialog onClose={() => setCreating(false)} />}

      {data === undefined && isError ? (
        <ErrorState what="playlists" retry={refetch} />
      ) : data === undefined ? (
        <LoadingState variant="grid" />
      ) : playlists.length === 0 ? (
        <>
          <div className="covergrid covergrid--phoneonly">
            <FavoritesTile />
          </div>
          <EmptyState
            icon={<IconPlaylists size={26} />}
            title="No playlists yet"
            hint="Create a playlist and drag songs in — reorder them any time."
            action={
              <button
                type="button"
                className="btn empty-state__action"
                onClick={() => setCreating(true)}
              >
                <IconPlus size={15} />
                New Playlist
              </button>
            }
          />
        </>
      ) : (
        <div className="covergrid">
          <FavoritesTile />
          {playlists.map((playlist) => (
            <PlaylistCard key={playlist.id} playlist={playlist} />
          ))}
        </div>
      )}
    </section>
  );
}

/* Phones only: the tab bar holds five sections, so Favorites lives here
   as the pinned first tile — the playlist Flow keeps for you. It keeps
   its own address. */
function FavoritesTile() {
  const { data: count } = useQuery({
    queryKey: ["tracks", "favorites", "count"],
    queryFn: async () => {
      const { data } = await api.GET("/api/tracks", {
        params: { query: { favorite: true, limit: 1 } },
      });
      return data?.total ?? null;
    },
  });
  return (
    <div className="album-card album-card--phoneonly">
      <div className="album-card__artwrap">
        <Link to="/favorites" className="album-card__artlink" aria-label="Favorites">
          <span className="album-card__art favoritestile" aria-hidden="true">
            <IconHeartFill size={44} />
          </span>
        </Link>
      </div>
      <Link to="/favorites" className="album-card__title">
        Favorites
      </Link>
      <div className="album-card__meta">
        {count == null ? "\u00A0" : `${fmtCount(count)} ${count === 1 ? "song" : "songs"}`}
      </div>
    </div>
  );
}

/* How long an armed delete stays armed before disarming itself. */
const CONFIRM_ARM_MS = 5000;

function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  const playTracks = usePlayerStore((s) => s.playTracks);
  const playNextMany = usePlayerStore((s) => s.playNextMany);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const deletePlaylist = useDeletePlaylist();
  const [menuOpen, setMenuOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [addingTracks, setAddingTracks] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const origin: QueueOrigin = {
    kind: "playlist",
    label: playlist.name,
    href: `/playlists/${playlist.id}`,
  };

  // Tracks resolve when an action asks for them — never on grid render.
  // The card's Play shares the fetch (on demand, below); the menu's items
  // read the query result once opening it has triggered the load. Same key
  // the detail view caches under, so opening the playlist later reuses
  // what the menu already fetched.
  const fetchDetail = async () => {
    const { data } = await api.GET("/api/playlists/{playlist_id}", {
      params: { path: { playlist_id: playlist.id } },
    });
    return data;
  };
  const { data: detail } = useQuery({
    queryKey: ["playlist", playlist.id],
    queryFn: fetchDetail,
    enabled: menuOpen,
  });
  const tracks = detail?.tracks ?? [];

  // Shared menu lifecycle: outside tap, Esc, navigation teardown.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node) || inCardSheet(e.target)) return;
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

  // The armed delete disarms itself: on close, and after five seconds —
  // a hesitate-means-no guard (the CollectionActions grammar).
  useEffect(() => {
    if (!menuOpen) {
      setArmed(false);
      return;
    }
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [menuOpen, armed]);

  const act = (fn: () => void) => () => {
    fn();
    setMenuOpen(false);
  };

  // Play resolves the list on demand — cache when something (the menu, a
  // detail visit) already fetched it, one server call when not. The button
  // must never sit disabled waiting on that fetch: a disabled play is a
  // dead tap AND the arrow cursor the action pair must never show.
  const play = async () => {
    // Claimed inside the click: unlocks audio before the await (iOS), and
    // a newer play started meanwhile wins.
    const isCurrent = beginPlayRequest();
    const resolved =
      detail ??
      (await queryClient.fetchQuery({
        queryKey: ["playlist", playlist.id],
        queryFn: fetchDetail,
      }));
    const list = resolved?.tracks ?? [];
    if (list.length > 0 && isCurrent()) playTracks(list, 0, origin);
  };
  const shuffle = () => {
    if (tracks.length === 0) return;
    const start = Math.floor(Math.random() * tracks.length);
    usePlayerStore.getState().setShuffle(true);
    playTracks(tracks, start, origin);
  };
  const loading = menuOpen && detail === undefined;
  // Touch: no buttons on the cover — a long press on it opens the menu.
  const longPress = useCardLongPress(() => setMenuOpen(true));

  return (
    <div className="album-card">
      <div className="album-card__artwrap" {...longPress}>
        <Link to={`/playlists/${playlist.id}`} className="album-card__artlink" aria-label={playlist.name}>
          <PlaylistArt
            artworkIds={playlist.artwork_ids}
            coverArtworkId={playlist.cover_artwork_id}
            size={180}
            radius="m"
            className="album-card__art"
          />
        </Link>
        {/* The corner placement lives on this wrapper — without it the play
            circle drops into the flow below the art. The action pair + menu
            mirror the album card exactly, so curation works from either grid
            the same way. */}
        <div className="album-card__hoveractions" ref={menuRef}>
          <button
            type="button"
            className="album-card__play"
            onClick={play}
            aria-label={`Play ${playlist.name}`}
            title="Play playlist"
          >
            <IconPlay size={20} />
          </button>
          <button
            type="button"
            className="album-card__more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${playlist.name}`}
            title="Playlist actions"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <IconEllipsis size={16} />
          </button>
          {menuOpen && (
            <CardMenu
              label={`Actions for ${playlist.name}`}
              title={playlist.name}
              subtitle="Playlist"
              onClose={() => setMenuOpen(false)}
            >
              <button type="button" role="menuitem" className="trackmenu__item" onClick={act(play)}>
                <IconPlay size={15} />
                Play
              </button>
              <button type="button" role="menuitem" className="trackmenu__item" onClick={act(shuffle)}>
                <IconShuffle size={15} />
                Shuffle
              </button>
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                onClick={act(() => playNextMany(tracks))}
                disabled={loading || tracks.length === 0}
              >
                <IconNext size={15} />
                Play Next
              </button>
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                onClick={act(() => addToQueue(tracks))}
                disabled={loading || tracks.length === 0}
              >
                <IconQueue size={15} />
                Add to Queue
              </button>
              {/* A playlist is a destination, not a source: where the album
                  menu files tracks elsewhere, this one fills the playlist. */}
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                onClick={act(() => setAddingTracks(true))}
                disabled={detail === undefined}
              >
                <IconPlus size={15} />
                Add Songs
              </button>
              <div className="trackmenu__separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className={`trackmenu__item trackmenu__item--danger${
                  armed ? " collactions__item--armed" : ""
                }`}
                onClick={() => {
                  // Two-step confirm: arm in place first, fire second.
                  if (!armed) {
                    setArmed(true);
                    return;
                  }
                  setMenuOpen(false);
                  void deletePlaylist(playlist.id);
                }}
              >
                <IconTrash size={15} />
                {armed ? "Confirm Delete" : "Delete Playlist"}
              </button>
            </CardMenu>
          )}
        </div>
      </div>
      <Link to={`/playlists/${playlist.id}`} className="album-card__title">
        {playlist.name}
      </Link>
      <div className="album-card__meta">
        {fmtCount(playlist.track_count)} song{playlist.track_count === 1 ? "" : "s"}
        {playlist.track_count > 0 ? ` · ${fmtMinutes(playlist.duration_total)}` : ""}
      </div>
      {addingTracks && detail && (
        <AddTracksDialog
          kind="playlist"
          playlist={detail}
          onClose={() => setAddingTracks(false)}
        />
      )}
    </div>
  );
}
