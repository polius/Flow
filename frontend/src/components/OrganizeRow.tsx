/* One Organize row (§22): checkbox · track number · title · artist · album ·
   file. The editing grammar matches the library's click-to-edit (§15.1) — a
   focused click on the words opens the editor; row clicks select. No
   playback here: this view organizes (§22), and row click must stay
   unambiguous. The hover-revealed ⓘ is gone (§25): right-click opens the
   app-wide track menu (Get Info included) — the same gesture as every other
   row in the app — and on phones, where cells are not editable, a tap on
   the re-templated row opens Get Info directly (§21's designed-refusal
   pattern, §22). The File column is read-only reference data: the file name
   with its library-relative path on hover. */

import type { CSSProperties } from "react";

import type { Track } from "../api/types";
import { fmtBasename } from "../lib/format";
import { Artwork } from "./Artwork";
import { InlineEdit } from "./InlineEdit";
import { IconCheck } from "./icons";

const ROW_HEIGHT = 38;

export interface RowMods {
  shiftKey: boolean;
  metaKey: boolean;
}

interface OrganizeRowProps {
  track: Track;
  index: number;
  style?: CSSProperties;
  checked: boolean;
  isCursor: boolean;
  isCurrent: boolean;
  compact: boolean;
  /** Grid keyboard: Enter opens this row's title editor once. */
  editTitle: boolean;
  onToggle: (track: Track, index: number, mods: RowMods) => void;
  onOpenInfo: (track: Track) => void;
  /** Right-click: the app-wide track menu (Get Info's desktop entry). */
  onTrackMenu?: (track: Track, x: number, y: number) => void;
  onCommitTitle: (track: Track, title: string) => void;
  onCommitArtist: (track: Track, artist: string) => void;
  onCommitAlbum: (track: Track, album: string) => void;
  onCommitTrackNo: (track: Track, value: number | null) => void;
}

/** Track number cell: a number when set, a quiet dash placeholder when not.
    Empty commits clear (explicit null on the wire); garbage cancels. */
function NumberCell({
  value,
  label,
  onCommit,
}: {
  value: number | null;
  label: string;
  onCommit: (value: number | null) => void;
}) {
  const shown = value != null ? String(value) : "";
  return (
    <InlineEdit
      value={shown}
      ariaLabel={label}
      className="orgrow__no"
      placeholder="—"
      allowEmpty
      onCommit={(text) => {
        if (text === "") {
          onCommit(null);
          return;
        }
        const n = Number(text);
        if (Number.isInteger(n) && n > 0) onCommit(n);
      }}
    />
  );
}

export function OrganizeRow({
  track,
  index,
  style,
  checked,
  isCursor,
  isCurrent,
  compact,
  editTitle,
  onToggle,
  onOpenInfo,
  onTrackMenu,
  onCommitTitle,
  onCommitArtist,
  onCommitAlbum,
  onCommitTrackNo,
}: OrganizeRowProps) {
  const classes = [
    "orgrow",
    isCurrent ? "orgrow--playing" : "",
    checked && !isCurrent ? "orgrow--selected" : "",
    isCursor && !checked && !isCurrent ? "orgrow--cursor" : "",
    compact ? "orgrow--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const mods = (e: React.MouseEvent): RowMods => ({
    shiftKey: e.shiftKey,
    metaKey: e.metaKey || e.ctrlKey,
  });

  const onContextMenu = onTrackMenu
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        onTrackMenu(track, e.clientX, e.clientY);
      }
    : undefined;

  if (compact) {
    return (
      <div
        className={classes}
        style={style}
        role="row"
        aria-selected={checked}
        onClick={() => onOpenInfo(track)}
      >
        <span className="orgrow__art">
          <Artwork artworkId={track.artwork_id} size={34} radius="s" />
        </span>
        <span className="orgrow__names">
          <span className="orgrow__titletext">{track.title}</span>
          <span className="orgrow__meta">
            {track.artist ?? "No artist"} · {track.album ?? "No album"}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div
      className={classes}
      style={style}
      role="row"
      aria-selected={checked}
      onClick={(e) => onToggle(track, index, mods(e))}
      onContextMenu={onContextMenu}
    >
      <span className="orgrow__check" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? `Deselect ${track.title}` : `Select ${track.title}`}
          className={`orgbox${checked ? " orgbox--on" : ""}`}
          onClick={() => onToggle(track, index, { shiftKey: false, metaKey: false })}
        >
          {checked && <IconCheck size={11} />}
        </button>
      </span>
      <span className="orgrow__nocell" onClick={(e) => e.stopPropagation()}>
        <NumberCell
          value={track.track_no}
          label={`Track number for ${track.title}`}
          onCommit={(n) => onCommitTrackNo(track, n)}
        />
      </span>
      <span className="orgrow__titlecell" onClick={(e) => e.stopPropagation()}>
        {/* Text only (owner, 2026-10-02): the 24px artwork left the title
            cell — one icon per row read as noise in a mass-editing grid. */}
        <InlineEdit
          value={track.title}
          ariaLabel={`Rename ${track.title}`}
          className="orgrow__titletext"
          startInEdit={editTitle}
          onCommit={(title) => onCommitTitle(track, title)}
        />
      </span>
      <span className="orgrow__cell" onClick={(e) => e.stopPropagation()}>
        <InlineEdit
          value={track.artist ?? ""}
          ariaLabel={`Artist for ${track.title}`}
          placeholder="No artist"
          className="orgrow__celltext"
          allowEmpty
          onCommit={(artist) => onCommitArtist(track, artist)}
        />
      </span>
      <span className="orgrow__cell" onClick={(e) => e.stopPropagation()}>
        <InlineEdit
          value={track.album ?? ""}
          ariaLabel={`Album for ${track.title}`}
          placeholder="No album"
          className="orgrow__celltext"
          allowEmpty
          onCommit={(album) => onCommitAlbum(track, album)}
        />
      </span>
      <span className="orgrow__file" title={track.path}>
        {fmtBasename(track.path)}
      </span>
    </div>
  );
}

export { ROW_HEIGHT };
