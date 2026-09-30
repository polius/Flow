/* Add Tracks — the one library picker (§23): search the whole library —
   title, artist, or album, so typing an album name surfaces its songs —
   select any number of tracks, and add them in one commit. Two targets:
   a playlist (its detail view owns membership) and the QUEUE (the queue
   panel's Add button; tracks land at the end of the play order). Enter
   toggles the highlighted row, Esc closes. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import type { PlaylistDetail, Track } from "../api/types";
import { useAddToPlaylist } from "../api/mutations";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import { IconCheck, IconClose, IconPlus, IconQueue, IconSearch } from "./icons";
import { PlaylistArt } from "./PlaylistArt";
import { fmtDuration, fmtMinutes } from "../lib/format";
import "../styles/editing.css";

type AddTracksDialogProps =
  | { kind: "playlist"; playlist: PlaylistDetail; onClose: () => void }
  | { kind: "queue"; onClose: () => void };

/** The picker reads one page of results; the search field narrows the rest. */
const RESULT_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 150;

export function AddTracksDialog(props: AddTracksDialogProps) {
  const { onClose } = props;
  const addToPlaylist = useAddToPlaylist();
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Map<number, Track>>(new Map());
  const [adding, setAdding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Registered like any modal (§15.7): Now Playing's Esc and the global
  // shortcut guard defer while the picker is up.
  useEffect(() => {
    useUiStore.getState().setPickerOpen(true);
    return () => useUiStore.getState().setPickerOpen(false);
  }, []);

  // Debounce the query so fast typing doesn't thrash the library table.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(input.trim());
      setCursor(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  // Autofocus the search field; Esc closes (§15.7 — dialogs above views).
  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const { data, isPending } = useQuery({
    queryKey: ["tracks", "picker", q],
    queryFn: async () => {
      const { data } = await api.GET("/api/tracks", {
        params: { query: { limit: RESULT_LIMIT, ...(q ? { q } : {}) } },
      });
      return data;
    },
    placeholderData: (prev) => prev,
  });

  const results = data?.items ?? [];
  const total = data?.total ?? 0;

  const existingIds = useMemo(
    () =>
      props.kind === "playlist"
        ? new Set(props.playlist.tracks.map((t) => t.id))
        : new Set<number>(),
    [props],
  );
  // Selectable = everything not already in the playlist (queue: everything).
  const selectable = useMemo(
    () => results.filter((t) => !existingIds.has(t.id)),
    [results, existingIds],
  );

  const toggle = (track: Track) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(track.id)) next.delete(track.id);
      else next.set(track.id, track);
      return next;
    });
  };

  const selectAll = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const t of selectable) next.set(t.id, t);
      return next;
    });
  };

  const clear = () => setSelected(new Map());

  const commit = async () => {
    if (selected.size === 0 || adding) return;
    const tracks = [...selected.values()];
    if (props.kind === "playlist") {
      setAdding(true);
      const ok = await addToPlaylist(
        props.playlist.id,
        [...selected.keys()].sort((a, b) => a - b),
      );
      setAdding(false);
      if (ok) onClose();
    } else {
      // Append to the end of the play order — the queue panel is where a
      // queue gets built (§23); click-to-jump starts any of them.
      addToQueue(tracks);
      onClose();
    }
  };

  // Arrows move the highlight, Enter/Space toggles — from the search field,
  // so the whole picker runs without leaving the keyboard. Toggle only when
  // the list reflects what's typed: pressing Enter mid-debounce must not act
  // on the previous query's results.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const settled = q === input.trim();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      const track = results[cursor];
      if (settled && track && !existingIds.has(track.id)) {
        e.preventDefault();
        toggle(track);
      }
    }
  };

  const selectedCount = selected.size;
  const selectedSeconds = [...selected.values()].reduce(
    (sum, t) => sum + (t.duration ?? 0),
    0,
  );
  const allSelected = selectable.length > 0 && selectedCount >= selectable.length;

  const identity =
    props.kind === "playlist" ? (
      <>
        <PlaylistArt
          artworkIds={props.playlist.artwork_ids}
          coverArtworkId={props.playlist.cover_artwork_id}
          size={52}
          radius="m"
        />
        <div className="addtracks__identity">
          <h2 className="addtracks__title">Add to {props.playlist.name}</h2>
          <p className="addtracks__sub">
            {props.playlist.track_count === 0
              ? "Search your library, then select the tracks to add."
              : `Search your library — ${props.playlist.track_count} ${
                  props.playlist.track_count === 1 ? "track is" : "tracks are"
                } already in this playlist.`}
          </p>
        </div>
      </>
    ) : (
      <>
        <span className="addtracks__queuetile" aria-hidden="true">
          <IconQueue size={22} />
        </span>
        <div className="addtracks__identity">
          <h2 className="addtracks__title">Add to Queue</h2>
          <p className="addtracks__sub">
            Search your library — tracks are added to the end of the queue.
          </p>
        </div>
      </>
    );

  return (
    <>
      <div className="addtracks__scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="addtracks"
        role="dialog"
        aria-modal="true"
        aria-label={
          props.kind === "playlist"
            ? `Add tracks to ${props.playlist.name}`
            : "Add tracks to the queue"
        }
      >
        <header className="addtracks__head">
          {identity}
          <button
            type="button"
            className="addtracks__close"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="addtracks__search">
          <span className="addtracks__searchicon">
            <IconSearch size={15} />
          </span>
          <input
            ref={searchRef}
            className="addtracks__searchinput"
            value={input}
            placeholder="Search songs, artists, or albums…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onSearchKeyDown}
            aria-label="Search the library"
          />
        </div>

        <div className="addtracks__listhead">
          <span className="addtracks__listmeta">
            {q
              ? total > RESULT_LIMIT
                ? `Showing ${results.length} of ${total} matches`
                : `${results.length} ${results.length === 1 ? "match" : "matches"}`
              : total > 0
                ? `Library${total > RESULT_LIMIT ? ` — ${total} tracks` : ""}`
                : "Library"}
          </span>
          {selectable.length > 1 && (
            <div className="addtracks__bulk">
              {selectedCount > 0 && (
                <button type="button" className="addtracks__bulkbtn" onClick={clear}>
                  Clear
                </button>
              )}
              {!allSelected && (
                <button type="button" className="addtracks__bulkbtn" onClick={selectAll}>
                  Select all
                </button>
              )}
            </div>
          )}
        </div>

        <div className="addtracks__list" role="listbox" aria-multiselectable="true" aria-label="Library tracks">
          {isPending && results.length === 0 ? (
            <div className="addtracks__placeholder">Loading your library…</div>
          ) : results.length === 0 ? (
            <div className="addtracks__placeholder">
              {q ? (
                <>
                  Nothing matches “{q}”.
                  <span className="addtracks__placeholdersub">
                    Try a song, artist, or album name.
                  </span>
                </>
              ) : (
                <>
                  Your library is empty.
                  <span className="addtracks__placeholdersub">
                    Add music from Settings, then come back.
                  </span>
                </>
              )}
            </div>
          ) : (
            results.map((track, index) => {
              const inPlaylist = existingIds.has(track.id);
              const isSelected = selected.has(track.id);
              const classes = [
                "addtracks__row",
                isSelected ? "addtracks__row--selected" : "",
                index === cursor ? "addtracks__row--cursor" : "",
                inPlaylist ? "addtracks__row--in" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={track.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={inPlaylist}
                  className={classes}
                  onClick={() => toggle(track)}
                  onMouseEnter={() => setCursor(index)}
                >
                  <span className="addtracks__box" aria-hidden="true">
                    {(isSelected || inPlaylist) && <IconCheck size={12} />}
                  </span>
                  <Artwork artworkId={track.artwork_id} size={34} radius="s" />
                  <span className="addtracks__names">
                    <span className="addtracks__name">{track.title}</span>
                    <span className="addtracks__artist">
                      {[track.artist, track.album].filter(Boolean).join(" — ")}
                    </span>
                  </span>
                  {inPlaylist ? (
                    <span className="addtracks__inplaylist">
                      <IconCheck size={13} />
                      In playlist
                    </span>
                  ) : (
                    <span className="addtracks__duration">
                      {fmtDuration(track.duration)}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <footer className="addtracks__foot">
          <p className="addtracks__summary">
            {selectedCount === 0 ? (
              "Nothing selected"
            ) : (
              <>
                {selectedCount} {selectedCount === 1 ? "track" : "tracks"}
                {selectedSeconds > 0 && <> · {fmtMinutes(selectedSeconds)}</>}
              </>
            )}
          </p>
          <div className="addtracks__actions">
            <button type="button" className="addtracks__cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn--primary"
              onClick={() => void commit()}
              disabled={selectedCount === 0 || adding}
            >
              {adding ? (
                "Adding…"
              ) : (
                <>
                  <IconPlus size={14} />
                  Add {selectedCount > 0 ? selectedCount : ""}{" "}
                  {selectedCount === 1 ? "Track" : "Tracks"}
                </>
              )}
            </button>
          </div>
        </footer>
      </div>
    </>
  );
}
