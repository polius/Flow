/* Get Info — right-side editing panel. Edits land as SQLite overlays via
   PATCH /api/tracks/{id}; files are never touched. A save joins the same
   server-side undo generation as every other library edit, so the pill
   that follows can always take it back. */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { usePatchTrack, useToggleFavorite, useUndoTrackEdit } from "../api/mutations";
import { isTextEditingTarget } from "../lib/shortcuts";
import { useModalFocus } from "../lib/focus";
import { Artwork } from "./Artwork";
import { IconClose, IconHeart, IconHeartFill } from "./icons";
import { useUiStore } from "../stores/ui";
import "../styles/editing.css";

export function GetInfoPanel() {
  const trackId = useUiStore((s) => s.getInfoTrackId);
  const closeGetInfo = useUiStore((s) => s.closeGetInfo);
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  const patchTrack = usePatchTrack();
  const toggleFavorite = useToggleFavorite();
  const undoEdit = useUndoTrackEdit();
  const surfaceRef = useRef<HTMLElement>(null);

  // Modal focus. The panel itself takes focus — not a field: Esc
  // defers inside text (the "cancel the edit" grammar), and an auto-focused
  // field would swallow the first Esc.
  useModalFocus(surfaceRef, trackId != null);

  const { data: track } = useQuery({
    queryKey: ["tracks", "one", trackId],
    queryFn: async () => {
      const { data, response } = await api.GET("/api/tracks/{track_id}", {
        params: { path: { track_id: trackId! } },
      });
      if (!response.ok) return null;
      return data;
    },
    enabled: trackId != null,
  });

  // Form drafts; re-seeded whenever the panel opens on a (new) track.
  const [draft, setDraft] = useState({
    title: "",
    artist: "",
    albumArtist: "",
    album: "",
    trackNo: "",
  });
  useEffect(() => {
    if (track) {
      setDraft({
        title: track.title,
        artist: track.artist ?? "",
        albumArtist: track.album_artist ?? "",
        album: track.album ?? "",
        trackNo: track.track_no != null ? String(track.track_no) : "",
      });
    }
  }, [track]);

  // Esc closes the panel — unless focus sits in one of the fields (Esc
  // mid-edit means "cancel the edit", and the draft must survive a stray
  // dismissal).
  useEffect(() => {
    if (trackId == null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isTextEditingTarget(document.activeElement)) return;
      closeGetInfo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [trackId, closeGetInfo]);

  if (trackId == null) return null;

  const dirty =
    track != null &&
    (draft.title !== track.title ||
      draft.artist !== (track.artist ?? "") ||
      draft.albumArtist !== (track.album_artist ?? "") ||
      draft.album !== (track.album ?? "") ||
      draft.trackNo !== (track.track_no != null ? String(track.track_no) : ""));

  const save = async () => {
    if (!track) return;
    const body = {
      ...(draft.title !== track.title ? { title: draft.title } : {}),
      ...(draft.artist !== (track.artist ?? "") ? { artist: draft.artist } : {}),
      ...(draft.albumArtist !== (track.album_artist ?? "")
        ? { album_artist: draft.albumArtist }
        : {}),
      ...(draft.album !== (track.album ?? "") ? { album: draft.album } : {}),
      ...(draft.trackNo !== (track.track_no != null ? String(track.track_no) : "")
        ? { track_no: draft.trackNo === "" ? null : Number(draft.trackNo) }
        : {}),
    };
    const ok = await patchTrack(track.id, body);
    if (ok) {
      // The save lands in the same server-side undo generation as every
      // other library edit; the pill's Undo restores the previous values,
      // from wherever the panel was opened.
      showUndoNotice({
        message: `Updated “${draft.title.trim() || track.title}”`,
        undo: async () => {
          await undoEdit();
        },
      });
      closeGetInfo();
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    extras?: { type?: string; min?: number; placeholder?: string },
  ) => (
    <label className="getinfo__field">
      <span className="getinfo__label">{label}</span>
      <input
        className="getinfo__input"
        type={extras?.type ?? "text"}
        value={value}
        min={extras?.min}
        placeholder={extras?.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );

  return (
    <>
      <div className="getinfo__scrim" onClick={closeGetInfo} aria-hidden="true" />
      <aside
        ref={surfaceRef}
        className="getinfo"
        role="dialog"
        aria-label="Get Info"
        aria-modal="true"
      >
        <header className="getinfo__head">
          <h2 className="getinfo__title">Get Info</h2>
          <button
            type="button"
            className="getinfo__close"
            onClick={closeGetInfo}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </header>

        {track && (
          <div className="getinfo__body">
            <div className="getinfo__identity">
              <Artwork artworkId={track.artwork_id} size={96} radius="m" className="getinfo__art" />
              <div className="getinfo__identitymeta">
                <p className="getinfo__albumname">{track.album ?? "No album"}</p>
                <p className="getinfo__format">
                  {track.format.toUpperCase()} · {Math.round(track.duration)}s
                </p>
                <p className="getinfo__path" title={track.path}>
                  {track.path}
                </p>
                <button
                  type="button"
                  className="getinfo__favorite"
                  onClick={() => toggleFavorite(track)}
                  aria-label={track.favorite ? "Remove from favorites" : "Add to favorites"}
                >
                  {track.favorite ? <IconHeartFill size={17} /> : <IconHeart size={17} />}
                  {track.favorite ? "Favorited" : "Add to favorites"}
                </button>
              </div>
            </div>

            {field("Title", draft.title, (v) => setDraft({ ...draft, title: v }))}
            {field("Artist", draft.artist, (v) => setDraft({ ...draft, artist: v }))}
            {field("Album Artist", draft.albumArtist, (v) =>
              setDraft({ ...draft, albumArtist: v }),
            )}
            {field("Album", draft.album, (v) => setDraft({ ...draft, album: v }))}
            {field("Track Number", draft.trackNo, (v) => setDraft({ ...draft, trackNo: v }), {
              type: "number",
              min: 0,
              placeholder: "None",
            })}

            <p className="getinfo__hint">
              Edits are stored in Flow and never written to your files.
            </p>

            <div className="getinfo__actions">
              <button type="button" className="getinfo__cancel" onClick={closeGetInfo}>
                Cancel
              </button>
              <button
                type="button"
                className="btn--primary"
                onClick={save}
                disabled={!dirty}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
