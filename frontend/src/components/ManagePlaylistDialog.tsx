/* Manage Playlist — the single editing surface for a playlist (§9.2).
   The detail page stays read-only; everything editable lives here: cover,
   name, description, tags. Text fields commit on Save (one PATCH); the
   cover applies immediately (content-addressed artwork, sha1 dedup).
   The danger zone deletes the playlist after an in-place two-step confirm. */

import { useEffect, useRef, useState } from "react";

import type { PlaylistDetail } from "../api/types";
import {
  useDeletePlaylist,
  useUpdatePlaylist,
  useUploadPlaylistCover,
} from "../api/mutations";
import { IconClose } from "./icons";
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

  // Form drafts, seeded when the dialog opens.
  const [name, setName] = useState(playlist.name);
  const [description, setDescription] = useState(playlist.description ?? "");
  const [tags, setTags] = useState<string[]>(playlist.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [coverArtworkId, setCoverArtworkId] = useState<number | null>(
    playlist.cover_artwork_id,
  );
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

  const dirty =
    name.trim() !== playlist.name ||
    (description.trim() || "") !== (playlist.description ?? "") ||
    tags.join("\n") !== playlist.tags.join("\n");

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    setTagDraft("");
    setTags((prev) =>
      prev.some((t) => t.toLowerCase() === tag.toLowerCase()) ? prev : [...prev, tag],
    );
  };

  const onTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && tagDraft === "" && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1));
    }
  };

  const save = async () => {
    if (!dirty || saving || !name.trim()) return;
    setSaving(true);
    const ok = await updatePlaylist(playlist.id, {
      name: name.trim(),
      description: description.trim() || null,
      tags,
    });
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
      <div className="manage" role="dialog" aria-label="Manage playlist" aria-modal="true">
        <header className="manage__head">
          <h2 className="manage__title">Manage Playlist</h2>
          <button type="button" className="manage__close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </header>

        <div className="manage__body">
          <div className="manage__cover">
            <PlaylistArt
              artworkIds={playlist.artwork_ids}
              coverArtworkId={coverArtworkId}
              size={96}
              radius="m"
            />
            <div className="manage__coveractions">
              <button
                type="button"
                className="view__action"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Upload image"}
              </button>
              {coverArtworkId != null && (
                <button
                  type="button"
                  className="view__action"
                  onClick={() => void resetCover()}
                  disabled={uploading}
                >
                  Reset to tracks
                </button>
              )}
              <p className="manage__hint">
                JPEG or PNG, up to 10 MB. Without a custom cover the playlist shows its
                tracks’ artwork.
              </p>
            </div>
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

          <label className="manage__field">
            <span className="manage__label">Name</span>
            <input
              className="manage__input"
              value={name}
              placeholder="Playlist name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="manage__field">
            <span className="manage__label">Description</span>
            <textarea
              className="manage__input manage__input--area"
              rows={3}
              value={description}
              placeholder="Add a description…"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="manage__field">
            <span className="manage__label">Tags</span>
            <div className="manage__tags">
              {tags.map((tag) => (
                <span key={tag} className="chip">
                  {tag}
                  <button
                    type="button"
                    className="chip__x"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => setTags(tags.filter((t) => t !== tag))}
                  >
                    <IconClose size={10} />
                  </button>
                </span>
              ))}
              <input
                className="manage__tagsinput"
                value={tagDraft}
                placeholder={tags.length ? "Add tag…" : "Add a tag…"}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={onTagKeyDown}
                onBlur={addTag}
              />
            </div>
          </div>
        </div>

        <div className="manage__actions">
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

        <div className="manage__danger">
          <p className="manage__dangerhint">
            Deletes the playlist and its order. Your tracks stay in the library.
          </p>
          <button
            type="button"
            className={`manage__delete${confirmDelete ? " manage__delete--confirm" : ""}`}
            onClick={() => void remove()}
          >
            {confirmDelete ? "Confirm delete" : "Delete playlist"}
          </button>
        </div>
      </div>
    </>
  );
}
