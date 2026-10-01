/* Get Info — right-side editing panel (§9.3, §13.2). Edits land as SQLite
   overlays via PATCH /api/tracks/{id}; files are never touched. */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { usePatchTrack, useToggleFavorite } from "../api/mutations";
import { Artwork } from "./Artwork";
import { IconClose, IconHeart, IconHeartFill } from "./icons";
import { useUiStore } from "../stores/ui";
import "../styles/editing.css";

export function GetInfoPanel() {
  const trackId = useUiStore((s) => s.getInfoTrackId);
  const closeGetInfo = useUiStore((s) => s.closeGetInfo);
  const patchTrack = usePatchTrack();
  const toggleFavorite = useToggleFavorite();

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
  const [draft, setDraft] = useState({ title: "", artist: "", album: "", trackNo: "" });
  useEffect(() => {
    if (track) {
      setDraft({
        title: track.title,
        artist: track.artist ?? "",
        album: track.album ?? "",
        trackNo: track.track_no != null ? String(track.track_no) : "",
      });
    }
  }, [track]);

  useEffect(() => {
    if (trackId == null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeGetInfo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [trackId, closeGetInfo]);

  if (trackId == null) return null;

  const dirty =
    track != null &&
    (draft.title !== track.title ||
      draft.artist !== (track.artist ?? "") ||
      draft.album !== (track.album ?? "") ||
      draft.trackNo !== (track.track_no != null ? String(track.track_no) : ""));

  const save = async () => {
    if (!track) return;
    const body = {
      ...(draft.title !== track.title ? { title: draft.title } : {}),
      ...(draft.artist !== (track.artist ?? "") ? { artist: draft.artist } : {}),
      ...(draft.album !== (track.album ?? "") ? { album: draft.album } : {}),
      ...(draft.trackNo !== (track.track_no != null ? String(track.track_no) : "")
        ? { track_no: draft.trackNo === "" ? null : Number(draft.trackNo) }
        : {}),
    };
    const ok = await patchTrack(track.id, body);
    if (ok) closeGetInfo();
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
      <aside className="getinfo" role="dialog" aria-label="Get Info" aria-modal="true">
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
