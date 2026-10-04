/* New Playlist — the Playlists view's creation dialog. The old one-click
   flow created a nameless "New Playlist" the user then had to rename in
   the detail view; now the name (and optionally the cover) are asked for
   BEFORE anything is created. Create commits (empty names never create),
   Cancel — or Esc, or the scrim — closes without side effects. */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useCreatePlaylist, useUploadPlaylistCover } from "../api/mutations";
import { useModalFocus } from "../lib/focus";
import { useUiStore } from "../stores/ui";
import { IconClose, IconPlus } from "./icons";
import "../styles/editing.css";

interface CreatePlaylistDialogProps {
  onClose: () => void;
}

export function CreatePlaylistDialog({ onClose }: CreatePlaylistDialogProps) {
  const createPlaylist = useCreatePlaylist();
  const uploadCover = useUploadPlaylistCover();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Modal focus: focus lands in the name field, Tab cycles inside the
  // dialog, closing restores focus to the New Playlist button.
  useModalFocus(panelRef, true, { initial: () => nameInputRef.current });

  // Esc cancels; the shortcut guard defers while the picker is up.
  useEffect(() => {
    useUiStore.getState().setPickerOpen(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      useUiStore.getState().setPickerOpen(false);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // The preview URL is a loan: revoked when the selection changes or the
  // dialog unmounts.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const create = async () => {
    const trimmed = name.trim();
    if (busy || !trimmed) return;
    setBusy(true);
    const playlist = await createPlaylist(trimmed);
    if (!playlist) {
      setBusy(false);
      return;
    }
    // A failed cover must not fail the playlist: it exists, the user is
    // navigated to it, and the miss is said out loud instead of swallowed.
    if (file) {
      const ok = await uploadCover(playlist.id, file);
      if (!ok) {
        showUndoNotice({
          message: "Playlist created — but the cover couldn't be uploaded.",
        });
      }
    }
    setBusy(false);
    onClose();
    void navigate(`/playlists/${playlist.id}`);
  };

  return (
    <>
      <div className="addtracks__scrim" onClick={onClose} aria-hidden="true" />
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
          <p className="addto__sub">Name it, give it a cover, then create.</p>
        </header>
        <div className="addto__naming">
          <div className="addto__coverrow">
            <button
              type="button"
              className="addto__coverbutton"
              onClick={() => fileInputRef.current?.click()}
              aria-label={file ? "Change cover image" : "Add cover image"}
              title="JPEG or PNG"
            >
              {preview ? (
                <img src={preview} alt="" />
              ) : (
                <IconPlus size={18} />
              )}
            </button>
            <div className="addto__covermeta">
              <span className="addto__coverhint">
                {file
                  ? file.name
                  : "Optional — pick a cover image, or leave the 2×2 track mosaic."}
              </span>
              {file && (
                <button
                  type="button"
                  className="addto__coverremove"
                  onClick={() => {
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  <IconClose size={11} />
                  Remove cover
                </button>
              )}
            </div>
          </div>
          <input
            ref={nameInputRef}
            className="addto__nameinput"
            value={name}
            placeholder="Playlist name"
            aria-label="Playlist name"
            disabled={busy}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
          />
          <div className="addto__namingactions">
            <button
              type="button"
              className="addto__cancel"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn--primary"
              onClick={() => void create()}
              disabled={busy || !name.trim()}
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png"
          hidden
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
      </div>
    </>
  );
}
