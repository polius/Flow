/* The row action menu: one app-wide menu for any track row, opened by
   right-click (desktop) or long-press (touch) and rendered by a single
   host mounted in AppShell. Why it exists: hover-revealed row buttons
   don't exist on touch. The heart stays as a STATE indicator; the ACTION
   lives here, where it's always reachable. */

import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import { useToggleFavorite } from "../api/mutations";
import { useMediaQuery } from "../lib/media";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import {
  IconAlbums,
  IconArtists,
  IconHeart,
  IconHeartFill,
  IconInfo,
  IconMinus,
  IconNext,
  IconPlay,
  IconPlaylistAdd,
  IconPlus,
} from "./icons";
import "../styles/editing.css";

/** Below this the menu becomes a bottom action sheet (iOS grammar). */
const SHEET_BP = "(max-width: 640px)";

export function TrackActionsMenu() {
  const request = useUiStore((s) => s.trackMenu);
  const close = useUiStore((s) => s.closeTrackMenu);
  const sheet = useMediaQuery(SHEET_BP);
  const { pathname } = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleFavorite = useToggleFavorite();
  const play = usePlayerStore((s) => s.playTracks);
  const playNextMany = usePlayerStore((s) => s.playNextMany);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const openGetInfo = useUiStore((s) => s.openGetInfo);
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const navigate = useNavigate();

  const open = request != null;

  // Menu lifecycle: outside tap, Esc, navigation. Registered like every
  // other menu — contextMenuOpen tells Esc precedence and the global
  // shortcuts that a menu is up.
  useEffect(() => {
    if (!open || request == null) return;
    useUiStore.getState().setContextMenuOpen(true);
    const onPointerDown = (e: PointerEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // A long-press near the screen edge can fire scroll; a menu that stays
    // anchored while the world moves reads broken — close it. The menu's own
    // inner scroll (long item lists) doesn't count.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      useUiStore.getState().setContextMenuOpen(false);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request?.track.id, request?.x, request?.y]);

  // Close on navigation (Back/Forward, link activation inside the menu).
  useEffect(() => {
    close();
  }, [pathname, close]);

  if (request == null) return null;
  const { track, x, y, context, contextLoader, origin, removeFromPlaylist, selection } =
    request;
  // A right-click on a row inside a live selection acts on the WHOLE
  // selection: the verbs file, queue, and play every selected track,
  // not just the row under the pointer. Otherwise the row stands alone.
  const targets = selection && selection.length > 0 ? selection : [track];

  const act = (fn: () => void) => () => {
    fn();
    close();
  };

  // "Play" queues the row's whole context. Paged views hand over a loader
  // instead of their loaded pages: the menu must never play a queue
  // truncated to the scroll depth. If the loader fails, the loaded
  // context still plays. The origin rides along when the invoking
  // surface knows what it is — a hand-built context just stays manual.
  const playInContext = () => {
    const base = context ?? [track];
    if (!contextLoader) {
      play(base, Math.max(0, base.findIndex((t) => t.id === track.id)), origin);
      return;
    }
    void contextLoader()
      .then((full) =>
        play(
          full.length > 0 ? full : base,
          Math.max(0, (full.length > 0 ? full : base).findIndex((t) => t.id === track.id)),
          origin,
        ),
      )
      .catch(() =>
        play(base, Math.max(0, base.findIndex((t) => t.id === track.id)), origin),
      );
  };

  const items = (
    <>
      <button
        type="button"
        className="trackmenu__item"
        onClick={act(playInContext)}
      >
        <IconPlay size={15} />
        Play
      </button>
      <button
        type="button"
        className="trackmenu__item"
        onClick={act(() => playNextMany(targets))}
      >
        <IconNext size={15} />
        {targets.length > 1 ? "Play Next (selection)" : "Play Next"}
      </button>
      <button
        type="button"
        className="trackmenu__item"
        onClick={act(() => addToQueue(targets))}
      >
        <IconPlus size={15} />
        {targets.length > 1 ? `Add ${targets.length} to Queue` : "Add to Queue"}
      </button>
      <button
        type="button"
        className="trackmenu__item"
        onClick={act(() => openAddToPlaylist(targets))}
      >
        <IconPlaylistAdd size={15} />
        {targets.length > 1
          ? `Add ${targets.length} to Playlist`
          : "Add to Playlist"}
      </button>
      {/* The menu navigates — each destination present only when the
          track names that entity. Navigation closes the menu; the
          pathname effect would anyway. */}
      {(track.album_id != null || track.artist_id != null) && (
        <div className="trackmenu__separator" role="separator" />
      )}
      {track.album_id != null && (
        <button
          type="button"
          className="trackmenu__item"
          onClick={act(() => navigate(`/albums/${track.album_id}`))}
        >
          <IconAlbums size={15} />
          Go to Album
        </button>
      )}
      {track.artist_id != null && (
        <button
          type="button"
          className="trackmenu__item"
          onClick={act(() => navigate(`/artists/${track.artist_id}`))}
        >
          <IconArtists size={15} />
          Go to Artist
        </button>
      )}
      <div className="trackmenu__separator" role="separator" />
      <button
        type="button"
        className="trackmenu__item"
        onClick={act(() => toggleFavorite(track))}
      >
        {track.favorite ? (
          <IconHeartFill size={15} className="trackmenu__heart--on" />
        ) : (
          <IconHeart size={15} />
        )}
        {track.favorite ? "Remove from Favorites" : "Add to Favorites"}
      </button>
      <button
        type="button"
        className="trackmenu__item"
        onClick={act(() => openGetInfo(track.id))}
      >
        <IconInfo size={15} />
        Get Info
      </button>
      {removeFromPlaylist && (
        <>
          <div className="trackmenu__separator" role="separator" />
          <button
            type="button"
            className="trackmenu__item trackmenu__item--danger"
            onClick={act(removeFromPlaylist)}
          >
            <IconMinus size={15} />
            Remove from Playlist
          </button>
        </>
      )}
    </>
  );

  const identity = (
    <div className="trackmenu__identity">
      <Artwork artworkId={track.artwork_id} size={36} radius="s" />
      <div className="trackmenu__identitymeta">
        <span className="trackmenu__identitytitle">{track.title}</span>
        <span className="trackmenu__identitysub">
          {targets.length > 1
            ? `${targets.length} tracks selected`
            : track.artist ?? " "}
        </span>
      </div>
    </div>
  );

  if (sheet) {
    return (
      <div className="tracksheet__scrim" onClick={close}>
        <div
          ref={panelRef}
          className="tracksheet"
          role="menu"
          aria-label={`Actions for ${track.title}`}
        >
          <span className="tracksheet__grabber" aria-hidden="true" />
          {identity}
          {items}
        </div>
      </div>
    );
  }

  // Desktop popover: clamp inside the viewport with the menu's shadow margin.
  const W = 224;
  const H = 400; // identity + up to nine items and separators
  const left = Math.min(Math.max(8, x), window.innerWidth - W - 12);
  const top = Math.min(Math.max(8, y), window.innerHeight - H - 12);
  return (
    <div
      ref={panelRef}
      className="trackmenu trackmenu--fixed"
      role="menu"
      aria-label={`Actions for ${track.title}`}
      style={{ left, top }}
    >
      {identity}
      {items}
    </div>
  );
}
