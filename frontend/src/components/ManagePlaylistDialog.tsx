/* Manage Playlist — the single editing surface for a playlist (§9.2).
   The detail page stays read-only; everything editable lives here: cover
   and name. Text fields commit on Save (one PATCH); the
   cover applies immediately (content-addressed artwork, sha1 dedup).
   The danger zone deletes the playlist after an in-place two-step confirm. */

import { useEffect, useRef, useState } from "react";

import type { PlaylistDetail } from "../api/types";
import {
  useDeletePlaylist,
  useUpdatePlaylist,
  useUploadPlaylistCover,
} from "../api/mutations";
import { useModalFocus } from "../lib/focus";
import { IconClose, IconPlus, IconTrash } from "./icons";
import { PlaylistArt } from "./PlaylistArt";
import "../styles/editing.css";

interface ManagePlaylistDialogProps {
  playlist: PlaylistDetail;
  onClose: () => void;
  /** Called after the playlist is deleted — the owner navigates away. */
  onDeleted: () => void;
}

const CONFIRM_DELETE_MS = 5000;

export function ManagePlaylistDialog({
  playlist,
  onClose,
  onDeleted,
}: ManagePlaylistDialogProps) {
  const updatePlaylist = useUpdatePlaylist();
  const uploadCover = useUploadPlaylistCover();
  const deletePlaylist = useDeletePlaylist();
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Modal focus (§3.4): focus in, Tab cycled, focus restored on close.
  useModalFocus(surfaceRef, true);

  // Form drafts, seeded when the dialog opens. `coverOriginal` is the
  // snapshot at open time — the query cache may refresh the playlist prop
  // mid-edit (a cover upload invalidates it), and dirty must not reset.
  const [name, setName] = useState(playlist.name);
  const [coverArtworkId, setCoverArtworkId] = useState<number | null>(
    playlist.cover_artwork_id,
  );
  const [coverOriginal] = useState(playlist.cover_artwork_id);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A single armed click deletes; disarm again if the user hesitates.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), CONFIRM_DELETE_MS);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  // Dirty means "there is anything to commit": a renamed playlist, or a
  // cover change (upload/reset) that a Save should acknowledge. Changing
  // only the image must not lock Save behind a name edit.
  const nameDirty = name.trim() !== playlist.name;
  const coverDirty = coverArtworkId !== coverOriginal;
  const dirty = nameDirty || coverDirty;

  const save = async () => {
    if (!dirty || saving || !name.trim()) return;
    setSaving(true);
    const body: { name?: string; cover_artwork_id?: number | null } = {};
    if (nameDirty) body.name = name.trim();
    if (coverDirty) body.cover_artwork_id = coverArtworkId;
    const ok = await updatePlaylist(playlist.id, body);
    setSaving(false);
    if (ok) onClose();
  };

  const onPickCover = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    const updated = await uploadCover(playlist.id, file);
    setUploading(false);
    if (updated) setCoverArtworkId(updated.cover_artwork_id);
  };

  const resetCover = async () => {
    const ok = await updatePlaylist(playlist.id, { cover_artwork_id: null });
    if (ok) setCoverArtworkId(null);
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (await deletePlaylist(playlist.id)) onDeleted();
  };

  return (
    <>
      <div className="manage__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={surfaceRef}
        className="manage"
        role="dialog"
        aria-label="Manage playlist"
        aria-modal="true"
      >
        <header className="manage__head">
          <h2 className="manage__title">Manage Playlist</h2>
          <button type="button" className="manage__close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </header>

        <div className="manage__body">
          {/* Hero: the cover mirrors the detail page (art left, name right).
              The cover itself is the change affordance — hover or focus
              reveals the scrim; a custom cover adds a reset below it. */}
          <div className="manage__hero">
            <div className="manage__covercol">
              <button
                type="button"
                className={`manage__cover${uploading ? " manage__cover--busy" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                aria-label={coverArtworkId != null ? "Change cover image" : "Add cover image"}
              >
                <PlaylistArt
                  artworkIds={playlist.artwork_ids}
                  coverArtworkId={coverArtworkId}
                  size={120}
                  radius="m"
                />
                <span className="manage__coverscrim" aria-hidden="true">
                  {uploading ? (
                    "Uploading…"
                  ) : (
                    <>
                      <IconPlus size={17} />
                      Change
                    </>
                  )}
                </span>
              </button>
              {coverArtworkId != null && (
                <button
                  type="button"
                  className="manage__reset"
                  onClick={() => void resetCover()}
                  disabled={uploading}
                >
                  Remove image
                </button>
              )}
            </div>

            <div className="manage__herofields">
              <label className="manage__field">
                <span className="manage__label">Name</span>
                <input
                  className="manage__input manage__input--name"
                  value={name}
                  placeholder="Playlist name"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
          </div>

          <p className="manage__hint">
            JPEG or PNG, up to 10 MB. Without a custom cover the playlist shows its
            tracks’ artwork.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            hidden
            onChange={(e) => {
              void onPickCover(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        <footer className="manage__actions">
          <button
            type="button"
            className={`manage__delete${confirmDelete ? " manage__delete--confirm" : ""}`}
            onClick={() => void remove()}
            title="Deletes the playlist and its order. Your tracks stay in the library."
          >
            <IconTrash size={13} />
            {confirmDelete ? "Confirm delete" : "Delete playlist"}
          </button>
          <div className="manage__actiongroup">
            <button type="button" className="manage__cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn--primary"
              onClick={() => void save()}
              disabled={!dirty || saving || !name.trim()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </>
  );
}
