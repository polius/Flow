/* Add to Playlist — the destination picker (§2.1). The Add Tracks picker
   (§23) serves "I'm inside a playlist, find me songs"; this is the reverse
   gesture — "I'm looking at music, file it somewhere." One surface, both
   directions, so curation never dead-ends at a single path.

   Lists every playlist (mosaic art + honest count) plus "New Playlist",
   which first asks for a NAME (an inline step over the list — the dialog
   is already the modal, a second dialog inside it would be chrome for
   chrome's sake) and then creates and immediately adds. Enter opens the
   highlighted row, Esc closes; registered like every modal so Esc
   precedence holds (§15.7). */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { api } from "../api/client";
import { useAddToPlaylist, useCreatePlaylist } from "../api/mutations";
import { useModalFocus } from "../lib/focus";
import { useUiStore } from "../stores/ui";
import { IconCheck, IconClose, IconMusicNote, IconPlus } from "./icons";
import { PlaylistArt } from "./PlaylistArt";
import { fmtCount, fmtMinutes } from "../lib/format";
import "../styles/editing.css";

export function AddToPlaylistDialog() {
  const tracks = useUiStore((s) => s.addToPlaylistTarget);
  const close = useUiStore((s) => s.closeAddToPlaylist);
  const addToPlaylist = useAddToPlaylist();
  const createPlaylist = useCreatePlaylist();
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  // The New Playlist step: the list gives way to a name field — the user
  // names the destination before the tracks land in it.
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The created step (2026-10-03): a receipt, not an instant close — the
  // dialog says the playlist was created successfully and offers the direct
  // path to it, so a first playlist doesn't feel filed into the void.
  const [created, setCreated] = useState<{
    id: number;
    name: string;
    added: boolean;
  } | null>(null);

  const open = tracks != null && tracks.length > 0;

  // Modal focus (§3.4): focus in, Tab cycled, focus restored on close. The
  // panel itself (tabIndex=-1) is the host — its list rows are the controls.
  useModalFocus(panelRef, open);

  // Modal lifecycle (§15.7): Esc closes, the shortcut guard defers, and
  // the dialog owns its one moment of attention. Esc inside the naming
  // step unwinds the step first — the dialog closes on the second Esc.
  useEffect(() => {
    if (!open) return;
    useUiStore.getState().setPickerOpen(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (naming) {
        setNaming(false);
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      useUiStore.getState().setPickerOpen(false);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close, naming]);

  // The name field focuses the moment the step opens.
  useEffect(() => {
    if (naming) nameInputRef.current?.focus();
  }, [naming]);

  // A closed dialog leaves no step behind: the naming field and the
  // created receipt reset while hidden, so the next open lands on the
  // list (a stale receipt re-opening days later would read as a ghost).
  useEffect(() => {
    if (open) return;
    setNaming(false);
    setCreated(null);
    setNewName("");
  }, [open]);

  const { data } = useQuery({
    queryKey: ["playlists", "picker"],
    queryFn: async () => {
      const { data } = await api.GET("/api/playlists", {
        params: { query: { limit: 1000 } },
      });
      return data;
    },
    enabled: open,
  });

  if (!open) return null;
  const playlists = data?.items ?? [];
  const trackIds = tracks!.map((t) => t.id);
  const totalSeconds = tracks!.reduce((sum, t) => sum + (t.duration ?? 0), 0);

  const commit = async (playlistId: number) => {
    if (busy) return;
    setBusy(true);
    const ok = await addToPlaylist(playlistId, trackIds);
    setBusy(false);
    if (ok) close();
  };

  /** Enters the naming step: the list gives way to the name field, and
      nothing is created until the user names it (2026-10-03 — the old
      direct path created "New Playlist" with no say in the name). */
  const beginNaming = () => {
    setNewName("");
    setCreated(null);
    setNaming(true);
  };

  /** Creates the playlist, files the tracks into it, and lands on the
      created step — a receipt with the direct path to the new playlist
      (2026-10-03), not an instant close. */
  const createAndAdd = async () => {
    const name = newName.trim();
    if (busy || !name) return; // a nameless playlist is never created (2026-10-03)
    setBusy(true);
    const playlist = await createPlaylist(name);
    if (!playlist) {
      setBusy(false);
      setNaming(false);
      return;
    }
    const added = await addToPlaylist(playlist.id, tracks!.map((t) => t.id));
    setBusy(false);
    setNaming(false);
    setCreated({ id: playlist.id, name, added });
  };

  if (naming) {
    return (
      <>
        <div className="addtracks__scrim" onClick={close} aria-hidden="true" />
        <div
          ref={panelRef}
          className="addto addto--naming"
          role="dialog"
          aria-modal="true"
          aria-label="New Playlist"
          tabIndex={-1}
        >
          <header className="addto__head">
            <h2 className="addto__title">New Playlist</h2>
            <p className="addto__sub">
              {fmtCount(tracks!.length)} {tracks!.length === 1 ? "track" : "tracks"}
              {totalSeconds > 0 && <> · {fmtMinutes(totalSeconds)}</>} will land in it
            </p>
          </header>
          <div className="addto__naming">
            <input
              ref={nameInputRef}
              className="addto__nameinput"
              value={newName}
              placeholder="Playlist name"
              aria-label="Playlist name"
              disabled={busy}
              maxLength={200}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createAndAdd();
                }
              }}
            />
            <div className="addto__namingactions">
              <button
                type="button"
                className="addto__cancel"
                onClick={() => setNaming(false)}
                disabled={busy}
              >
                <IconClose size={13} />
                Cancel
              </button>
              <button
                type="button"
                className="btn--primary"
                onClick={() => void createAndAdd()}
                disabled={busy || !newName.trim()}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // The created step: a receipt — the dialog confirms the playlist was
  // created successfully and offers the direct path to it (2026-10-03).
  if (created) {
    return (
      <>
        <div className="addtracks__scrim" onClick={close} aria-hidden="true" />
        <div
          ref={panelRef}
          className="addto addto--naming"
          role="dialog"
          aria-modal="true"
          aria-label="Playlist created"
          tabIndex={-1}
        >
          <header className="addto__head">
            <h2 className="addto__title">New Playlist</h2>
          </header>
          <div className="addto__naming">
            <div className="addto__success">
              <span className="addto__successicon" aria-hidden="true">
                <IconCheck size={16} />
              </span>
              <div className="addto__successmeta">
                <span className="addto__successtitle">
                  Playlist created successfully
                </span>
                <span className="addto__successsub">
                  {created.added
                    ? `“${created.name}” · ${fmtCount(tracks!.length)} ${
                        tracks!.length === 1 ? "track" : "tracks"
                      } added`
                    : `“${created.name}” — but the tracks couldn't be added`}
                </span>
              </div>
            </div>
            <div className="addto__namingactions">
              <button type="button" className="addto__cancel" onClick={close}>
                Close
              </button>
              <button
                type="button"
                className="btn--primary"
                onClick={() => {
                  navigate(`/playlists/${created.id}`);
                  close();
                }}
              >
                Open Playlist
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const rowCount = playlists.length + 1; // + New Playlist
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rowCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor < playlists.length) void commit(playlists[cursor].id);
      else beginNaming();
    }
  };

  return (
    <>
      <div className="addtracks__scrim" onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        className="addto"
        role="dialog"
        aria-modal="true"
        aria-label="Add to Playlist"
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="addto__head">
          <h2 className="addto__title">Add to Playlist</h2>
          <p className="addto__sub">
            {fmtCount(tracks!.length)} {tracks!.length === 1 ? "track" : "tracks"}
            {totalSeconds > 0 && <> · {fmtMinutes(totalSeconds)}</>}
          </p>
        </header>
        <div className="addto__list" role="listbox" aria-label="Playlists">
          {playlists.map((playlist, index) => (
            <button
              key={playlist.id}
              type="button"
              role="option"
              aria-selected={cursor === index}
              className={`addto__row${cursor === index ? " addto__row--cursor" : ""}`}
              disabled={busy}
              onMouseEnter={() => setCursor(index)}
              onClick={() => void commit(playlist.id)}
            >
              <PlaylistArt
                artworkIds={playlist.artwork_ids}
                coverArtworkId={playlist.cover_artwork_id}
                size={36}
                radius="s"
              />
              <span className="addto__names">
                <span className="addto__name">{playlist.name}</span>
                <span className="addto__meta">
                  {fmtCount(playlist.track_count)}{" "}
                  {playlist.track_count === 1 ? "track" : "tracks"}
                </span>
              </span>
            </button>
          ))}
          {playlists.length === 0 && (
            <div className="addto__empty">
              <IconMusicNote size={18} />
              No playlists yet — the first one is one click away.
            </div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={cursor === playlists.length}
            className={`addto__row addto__row--new${
              cursor === playlists.length ? " addto__row--cursor" : ""
            }`}
            disabled={busy}
            onMouseEnter={() => setCursor(playlists.length)}
            onClick={beginNaming}
          >
            <span className="addto__newtile" aria-hidden="true">
              <IconPlus size={16} />
            </span>
            <span className="addto__names">
              <span className="addto__name">New Playlist</span>
              <span className="addto__meta">Name it, then these tracks land in it</span>
            </span>
          </button>
        </div>
        {busy && <div className="addto__busy">Adding…</div>}
      </div>
    </>
  );
}
