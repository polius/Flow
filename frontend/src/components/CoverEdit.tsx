/* The header cover cell: the artwork is its own edit affordance — click
   changes the image (the scrim reveals on hover/focus), the corner ×
   removes a user-set cover and the derived art takes back over. Shared by
   the playlist, album, and artist headers so the behavior cannot fork; the
   artist's cell masks to the circle its grid reads as a face. */

import { useRef, useState, type ReactNode } from "react";

import { IconClose, IconPlus } from "./icons";
import "../styles/library.css";
import "../styles/editing.css";

interface CoverEditProps {
  /** A user-set cover exists — the × shows; removing restores derived art. */
  hasCover: boolean;
  /** Round mask (the artist portrait); default square, playlist/album. */
  round?: boolean;
  /** Store the picked file — usually a mutation; its return value (if any)
      is ignored, the invalidations carry the update. */
  onFile: (file: File) => unknown;
  onRemove: () => void;
  /** The art itself: the PlaylistArt mosaic, an Artwork, or a portrait. */
  children: ReactNode;
}

export function CoverEdit({
  hasCover,
  round = false,
  onFile,
  onRemove,
  children,
}: CoverEditProps) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    await onFile(file);
    setUploading(false);
  };

  return (
    <div className="detailhead__artcol">
      <button
        type="button"
        className={`detailhead__artbutton${round ? " detailhead__artbutton--round" : ""}${
          uploading ? " detailhead__artbutton--busy" : ""
        }`}
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        aria-label={hasCover ? "Change cover image" : "Add cover image"}
        title="JPEG or PNG, up to 10 MB"
      >
        {children}
        <span className="detailhead__artscrim" aria-hidden="true">
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
      {hasCover && (
        <button
          type="button"
          className="detailhead__artremove"
          aria-label="Remove cover image"
          title="Remove cover image"
          onClick={onRemove}
        >
          <IconClose size={11} />
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={(e) => {
          void onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
