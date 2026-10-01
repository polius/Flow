/* Add Tracks — the one library picker (§23): search the whole library —
   title, artist, or album, so typing an album name surfaces its songs —
   select any number of tracks, and add them in one commit. Two targets:
   a playlist (its detail view owns membership) and the QUEUE (the queue
   panel's Add button; tracks land at the end of the play order). Enter
   toggles the highlighted row, Esc closes. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";

import { api } from "../api/client";
import type { PlaylistDetail, Track } from "../api/types";
import { useAddToPlaylist } from "../api/mutations";
import { useModalFocus } from "../lib/focus";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import { IconCheck, IconClose, IconNext, IconPlus, IconQueue, IconSearch } from "./icons";
import { PlaylistArt } from "./PlaylistArt";
import { fmtDuration, fmtMinutes } from "../lib/format";
import "../styles/editing.css";

type AddTracksDialogProps =
  | { kind: "playlist"; playlist: PlaylistDetail; onClose: () => void }
  | { kind: "queue"; onClose: () => void };

/** One page of results; "Load more" (§3.4) appends the next page, and
    Select all fetches every remaining page before selecting — the 200-row
    silent cap is gone. */
const PAGE_SIZE = 200;
/** Row height of .addtracks__row: 7px padding × 2 + 34px artwork. */
const ROW_HEIGHT = 48;
const SEARCH_DEBOUNCE_MS = 150;

export function AddTracksDialog(props: AddTracksDialogProps) {
  const { onClose } = props;
  const addToPlaylist = useAddToPlaylist();
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const playNextMany = usePlayerStore((s) => s.playNextMany);

  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Map<number, Track>>(new Map());
  const [adding, setAdding] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Modal focus (§3.4): the search field stays the first target (its own
  // autofocus runs first), Tab cycles inside the dialog, closing restores.
  useModalFocus(surfaceRef, true, { initial: () => searchRef.current });

  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["tracks", "picker", q],
      queryFn: async ({ pageParam }) => {
        const { data } = await api.GET("/api/tracks", {
          params: {
            query: { limit: PAGE_SIZE, offset: pageParam, ...(q ? { q } : {}) },
          },
        });
        return data;
      },
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) => {
        const loaded = allPages.reduce((n, p) => n + (p?.items.length ?? 0), 0);
        return loaded < (lastPage?.total ?? 0) ? loaded : undefined;
      },
      placeholderData: (prev) => prev,
    });

  const results = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p?.items ?? []),
    [data],
  );
  const total = data?.pages[0]?.total ?? 0;

  // Keep the keyboard cursor visible as the window scrolls (the picker list
  // is windowed now — select-all can load thousands of rows, §3.4).
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  useEffect(() => {
    if (cursor >= 0 && cursor < results.length) {
      virtualizer.scrollToIndex(cursor, { align: "auto" });
    }
  }, [cursor, virtualizer, results.length]);

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

  // "Select all" means ALL matches, not the loaded page (§3.4 — the old
  // picker silently capped at 200 while the header advertised the library).
  // Any unloaded pages are fetched first, then everything selects. The
  // loop reads the accumulated pages off each fetchNextPage result, so it
  // can't act on stale state.
  const selectAll = async () => {
    if (selectingAll) return;
    setSelectingAll(true);
    try {
      let pages = data?.pages ?? [];
      let more = hasNextPage;
      while (more) {
        const res = await fetchNextPage({ cancelRefetch: false });
        const fetched = res.data?.pages;
        if (fetched == null || fetched.length === pages.length) break;
        pages = fetched;
        const loaded = pages.reduce((n, p) => n + (p?.items.length ?? 0), 0);
        more = loaded < (pages[0]?.total ?? 0);
      }
      const all = pages.flatMap((p) => p?.items ?? []);
      setSelected((prev) => {
        const next = new Map(prev);
        for (const t of all) {
          if (!existingIds.has(t.id)) next.set(t.id, t);
        }
        return next;
      });
    } finally {
      setSelectingAll(false);
    }
  };

  const clear = () => setSelected(new Map());

  const commit = async (destination: "end" | "next" = "end") => {
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
      // §1.2: both destinations, append still the picker's default —
      // "Play Next" inserts after the playing row (playNextMany), "Add to
      // Queue" lands at the end. The store's arrival toast confirms either
      // way, with Undo.
      if (destination === "next") playNextMany(tracks);
      else addToQueue(tracks);
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
            Search your library — add them to play next, or the end of the
            queue.
          </p>
        </div>
      </>
    );

  return (
    <>
      <div className="addtracks__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={surfaceRef}
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
              ? total > results.length
                ? `Showing ${results.length} of ${total} matches`
                : `${results.length} ${results.length === 1 ? "match" : "matches"}`
              : total > 0
                ? `Library${total > results.length ? ` — ${results.length} of ${total}` : ""}`
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
                <button
                  type="button"
                  className="addtracks__bulkbtn"
                  onClick={() => void selectAll()}
                  disabled={selectingAll}
                >
                  {selectingAll ? "Selecting…" : "Select all"}
                </button>
              )}
            </div>
          )}
        </div>

        <div
          ref={listRef}
          className="addtracks__list"
          role="listbox"
          aria-multiselectable="true"
          aria-label="Library tracks"
        >
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
            <>
              {/* Windowed (§3.4): select-all can load the whole library, and
                  thousands of live rows would starve the dialog. Same element
                  virtualizer the queue drawer uses. */}
              <div
                className="addtracks__window"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const track = results[item.index];
                  if (!track) return null;
                  const inPlaylist = existingIds.has(track.id);
                  const isSelected = selected.has(track.id);
                  const classes = [
                    "addtracks__row",
                    isSelected ? "addtracks__row--selected" : "",
                    item.index === cursor ? "addtracks__row--cursor" : "",
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
                      style={{ transform: `translateY(${item.start}px)` }}
                      onClick={() => toggle(track)}
                      onMouseEnter={() => setCursor(item.index)}
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
                })}
              </div>
              {total > results.length && (
                <button
                  type="button"
                  className="addtracks__more"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage
                    ? "Loading…"
                    : `Load more — showing ${results.length} of ${total}`}
                </button>
              )}
            </>
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
            {/* §1.2: the picker keeps append as its default verb, but
                "Play Next" sits beside it — the same two destinations the
                menus offer, one quiet secondary. */}
            {props.kind === "queue" && (
              <button
                type="button"
                className="view__action"
                onClick={() => void commit("next")}
                disabled={selectedCount === 0 || adding}
              >
                <IconNext size={14} />
                Play Next
              </button>
            )}
            <button
              type="button"
              className="btn--primary"
              onClick={() => void commit("end")}
              disabled={selectedCount === 0 || adding}
            >
              {adding ? (
                "Adding…"
              ) : (
                <>
                  <IconPlus size={14} />
                  {props.kind === "queue" ? "Add to Queue" : "Add"}{" "}
                  {selectedCount > 0 ? selectedCount : ""}{" "}
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
