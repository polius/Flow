/* The Apple header trio — Play · Shuffle · … — for any body of music a
   detail page presents: albums, artists, playlists. One component for every
   detail view so the verbs can never drift between them. One exception:
   "Add to Playlist" lives everywhere except inside a playlist — filing a
   playlist into a playlist has no destination, so that surface opts out. */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { QueueOrigin, Track } from "../api/types";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { IconEllipsis, IconNext, IconPlay, IconPlus, IconQueue, IconShuffle } from "./icons";

/** A menu action beyond the shared curation set — rendered at the menu's
    end, after a separator. Navigation is just an onSelect that routes. */
export interface CollectionMenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Two-step confirm: the first click arms in place — the item's label
      becomes `confirmLabel` — and only the second fires. Arming expires
      after five seconds and disarms when the menu closes. */
  confirmLabel?: string;
  /** Destructive: wears the shared danger styling from the start. */
  danger?: boolean;
}

/** How long an armed confirm stays armed before disarming itself. */
const CONFIRM_ARM_MS = 5000;

interface CollectionActionsProps {
  tracks: Track[];
  /** Screen-reader label context: "album Dark Side" / "artist's songs". */
  label: string;
  /** What playing this collection means for the queue's origin —
      the caller knows what the view is; the store records it. */
  origin?: QueueOrigin | null;
  /** The menu items this surface adds: the playlist's editing verbs, the
      album's Go to Artist. Order follows the caller. */
  extraItems?: CollectionMenuItem[];
  /** Whether the "…" menu offers the shared "Add to Playlist" verb.
      Defaults true; the playlist surface passes false — the verb belongs
      everywhere except inside a playlist, where it has no destination. */
  addToPlaylist?: boolean;
}

export function CollectionActions({
  tracks,
  label,
  origin,
  extraItems,
  addToPlaylist = true,
}: CollectionActionsProps) {
  const playTracks = usePlayerStore((s) => s.playTracks);
  const playNextMany = usePlayerStore((s) => s.playNextMany);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const empty = tracks.length === 0;
  // The "…" button stays reachable when the surface declares items that
  // don't need tracks (the playlist's Delete) — a one-track menu with no
  // way to act on the collection itself would be a dead end.
  const menuUseful = !empty || (extraItems != null && extraItems.length > 0);

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

  // An armed confirm disarms itself: when the menu closes, and again five
  // seconds after arming — a hesitate-means-no guard.
  useEffect(() => {
    if (!open) {
      setArmed(null);
      return;
    }
    if (armed == null) return;
    const timer = window.setTimeout(() => setArmed(null), CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [open, armed]);

  const shufflePlay = () => {
    if (empty) return;
    const start = Math.floor(Math.random() * tracks.length);
    usePlayerStore.getState().setShuffle(true);
    playTracks(tracks, start, origin);
  };

  return (
    <div className="collactions" ref={wrapRef}>
      <button
        type="button"
        className="btn--primary"
        onClick={() => playTracks(tracks, 0, origin)}
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
          disabled={!menuUseful}
        >
          <IconEllipsis size={15} />
        </button>
        {open && (
          <div className="trackmenu collactions__pop" role="menu" aria-label={`More actions for ${label}`}>
            <button
              type="button"
              role="menuitem"
              className="trackmenu__item"
              disabled={empty}
              onClick={() => {
                playNextMany(tracks);
                setOpen(false);
              }}
            >
              <IconNext size={15} />
              Play Next
            </button>
            {/* The menus carry both destinations — insert-after-current is
                the default (the verb above), append is here under its own
                name. Arrival confirms via the toast, from the store action
                either way. */}
            <button
              type="button"
              role="menuitem"
              className="trackmenu__item"
              disabled={empty}
              onClick={() => {
                addToQueue(tracks);
                setOpen(false);
              }}
            >
              <IconQueue size={15} />
              Add to Queue (end)
            </button>
            {addToPlaylist && (
              <button
                type="button"
                role="menuitem"
                className="trackmenu__item"
                disabled={empty}
                onClick={() => {
                  openAddToPlaylist(tracks);
                  setOpen(false);
                }}
              >
                <IconPlus size={15} />
                Add to Playlist
              </button>
            )}
            {extraItems && extraItems.length > 0 && (
              <>
                <div className="trackmenu__separator" role="separator" />
                {extraItems.map((item) => {
                  const isArmed = item.confirmLabel != null && armed === item.label;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      className={`trackmenu__item${
                        item.danger ? " trackmenu__item--danger" : ""
                      }${isArmed ? " collactions__item--armed" : ""}`}
                      onClick={() => {
                        // Two-step confirm: arm in place first, fire second.
                        if (item.confirmLabel != null && !isArmed) {
                          setArmed(item.label);
                          return;
                        }
                        item.onSelect();
                        setOpen(false);
                      }}
                    >
                      {item.icon}
                      {isArmed ? item.confirmLabel : item.label}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
