/* Album cover card for grids: art-forward, hover reveals play. The "…"
   beside it is the per-album slice of the header trio, so curation works
   from any grid — the actions resolve the album's full track list on
   demand. */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import type { AlbumSummary, QueueOrigin } from "../api/types";
import { beginPlayRequest, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { useCardKeys } from "../lib/cardFocus";
import { Artwork } from "./Artwork";
import { CardMenu } from "./CardMenu";
import { inCardSheet, useCardLongPress } from "../lib/cardMenu";
import {
  IconEllipsis,
  IconNext,
  IconPlay,
  IconPlaylistAdd,
  IconQueue,
  IconShuffle,
} from "./icons";
import "../styles/library.css";

export function AlbumCard({ album }: { album: AlbumSummary }) {
  const playTracks = usePlayerStore((s) => s.playTracks);
  const playNextMany = usePlayerStore((s) => s.playNextMany);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // The album IS the origin: playing or shuffling the card names
  // it, so the queue's "Playing from" sentence is born telling the truth.
  const origin: QueueOrigin = {
    kind: "album",
    label: album.title,
    href: `/albums/${album.id}`,
  };

  // Tracks resolve when an action asks for them — never on grid render.
  // The card's Play shares the fetch (on demand, below); the menu's items
  // read the query result once opening it has triggered the load. Same key
  // the detail view caches under, so a visit reuses what the card fetched.
  const fetchDetail = async () => {
    const { data } = await api.GET("/api/albums/{album_id}", {
      params: { path: { album_id: album.id } },
    });
    return data;
  };
  const { data: detail } = useQuery({
    queryKey: ["album", album.id],
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
        queryKey: ["album", album.id],
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

  const { coverRef, onCoverKeyDown, onMenuKeyDown, onMenuBlur } = useCardKeys(
    menuOpen,
    setMenuOpen,
    menuRef,
  );

  return (
    <div className="album-card">
      <div className="album-card__artwrap" {...longPress}>
        <Link
          ref={coverRef}
          to={`/albums/${album.id}`}
          className="album-card__artlink"
          aria-label={album.title}
          aria-haspopup="menu"
          onKeyDown={onCoverKeyDown}
        >
          <Artwork
            artworkId={album.cover_artwork_id ?? album.artwork_id}
            size={180}
            radius="m"
            className="album-card__art"
          />
        </Link>
        <div className="album-card__hoveractions" ref={menuRef}>
          <button
            type="button"
            className="album-card__play"
            // Pointer affordances: the keyboard has the cover (one Tab stop
            // per card) and reaches these through the card's menu.
            tabIndex={-1}
            onClick={play}
            aria-label={`Play ${album.title}`}
            title="Play album"
          >
            <IconPlay size={20} />
          </button>
          <button
            type="button"
            className="album-card__more"
            tabIndex={-1}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${album.title}`}
            title="Album actions"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <IconEllipsis size={16} />
          </button>
          {menuOpen && (
            <CardMenu
              label={`Actions for ${album.title}`}
              title={album.title}
              subtitle={album.artist}
              onClose={() => setMenuOpen(false)}
              onKeyDown={onMenuKeyDown}
              onBlur={onMenuBlur}
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
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                onClick={act(() => openAddToPlaylist(tracks))}
                disabled={loading || tracks.length === 0}
              >
                <IconPlaylistAdd size={15} />
                Add to Playlist
              </button>
            </CardMenu>
          )}
        </div>
      </div>
      {/* The same destination as the cover: out of the Tab order, so a
          card is one stop, not two links to one place. */}
      <Link to={`/albums/${album.id}`} className="album-card__title" tabIndex={-1}>
        {album.title}
      </Link>
      <div className="album-card__meta">
        {album.artist ?? "Unknown artist"}
        {album.year != null ? ` · ${album.year}` : ""}
      </div>
    </div>
  );
}
