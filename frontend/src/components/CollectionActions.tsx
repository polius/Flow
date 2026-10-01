/* CollectionActions (§2.1): the Apple header trio — Play · Shuffle · … —
   for any body of music an album/artist page presents. The "…" menu carries
   the two curation moves the header owes: Play Next (into the live queue,
   in order) and Add to Playlist (the destination dialog). One component for
   both detail views so the grammar can never drift between them. */

import { useEffect, useRef, useState } from "react";

import type { Track } from "../api/types";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { IconEllipsis, IconNext, IconPlay, IconPlus, IconShuffle } from "./icons";

interface CollectionActionsProps {
  tracks: Track[];
  /** Screen-reader label context: "album Dark Side" / "artist's songs". */
  label: string;
}

export function CollectionActions({ tracks, label }: CollectionActionsProps) {
  const playTracks = usePlayerStore((s) => s.playTracks);
  const playNextMany = usePlayerStore((s) => s.playNextMany);
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const empty = tracks.length === 0;

  // Menu lifecycle: outside tap, Esc, teardown — the shared menu grammar.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const shufflePlay = () => {
    if (empty) return;
    const start = Math.floor(Math.random() * tracks.length);
    usePlayerStore.getState().setShuffle(true);
    playTracks(tracks, start);
  };

  return (
    <div className="collactions" ref={wrapRef}>
      <button
        type="button"
        className="btn--primary"
        onClick={() => playTracks(tracks, 0)}
        disabled={empty}
      >
        <IconPlay size={15} />
        Play
      </button>
      <button
        type="button"
        className="view__action"
        onClick={shufflePlay}
        disabled={empty}
        aria-label={`Shuffle ${label}`}
        title={`Shuffle ${label}`}
      >
        <IconShuffle size={15} />
        Shuffle
      </button>
      <div className="collactions__more">
        <button
          type="button"
          className="view__action"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`More actions for ${label}`}
          onClick={() => setOpen((o) => !o)}
          disabled={empty}
        >
          <IconEllipsis size={15} />
        </button>
        {open && (
          <div className="trackmenu collactions__pop" role="menu" aria-label={`More actions for ${label}`}>
            <button
              type="button"
              role="menuitem"
              className="trackmenu__item"
              onClick={() => {
                playNextMany(tracks);
                setOpen(false);
              }}
            >
              <IconNext size={15} />
              Play Next
            </button>
            <button
              type="button"
              role="menuitem"
              className="trackmenu__item"
              onClick={() => {
                openAddToPlaylist(tracks);
                setOpen(false);
              }}
            >
              <IconPlus size={15} />
              Add to Playlist
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
