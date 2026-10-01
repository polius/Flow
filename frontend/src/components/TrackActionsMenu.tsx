/* The row action menu (§9.2 revision): one app-wide menu for any track row,
   opened by right-click (desktop) or long-press (touch) and rendered by a
   single host mounted in AppShell.

   Why it exists: hover-revealed row buttons don't exist on touch. Apple's
   answer — from iOS files to Music — is the long-press context menu, with
   an action-sheet form factor on compact screens. The heart stays as a
   STATE indicator; the ACTION lives here, where it's always reachable.

   Items: Play (in the row's context), Play next, Add to queue, Favorite,
   Get Info — and, when the row came from a playlist, Remove from Playlist
   (§25). Surface reuses the shared menu language (elevated panel, hairline
   border, scale-in). */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { useToggleFavorite } from "../api/mutations";
import { useMediaQuery } from "../lib/media";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import {
  IconHeart,
  IconHeartFill,
  IconInfo,
  IconMinus,
  IconNext,
  IconPlay,
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
  const playNext = usePlayerStore((s) => s.playNext);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const openGetInfo = useUiStore((s) => s.openGetInfo);

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
  const { track, x, y, context, contextLoader, removeFromPlaylist } = request;

  const act = (fn: () => void) => () => {
    fn();
    close();
  };

  // "Play" queues the row's whole context. Paged views hand over a loader
  // instead of their loaded pages: the menu must never play a queue
  // truncated to the scroll depth (§29). If the loader fails, the loaded
  // context still plays.
  const playInContext = () => {
    const base = context ?? [track];
    if (!contextLoader) {
      play(base, Math.max(0, base.findIndex((t) => t.id === track.id)));
      return;
    }
    void contextLoader()
      .then((full) =>
        play(
          full.length > 0 ? full : base,
          Math.max(0, (full.length > 0 ? full : base).findIndex((t) => t.id === track.id)),
        ),
      )
      .catch(() =>
        play(base, Math.max(0, base.findIndex((t) => t.id === track.id))),
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
        onClick={act(() => playNext(track))}
      >
        <IconNext size={15} />
        Play Next
      </button>
      <button
        type="button"
        className="trackmenu__item"
        onClick={act(() => addToQueue([track]))}
      >
        <IconPlus size={15} />
        Add to Queue
      </button>
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
        <span className="trackmenu__identitysub">{track.artist ?? " "}</span>
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
  const H = 300;
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
