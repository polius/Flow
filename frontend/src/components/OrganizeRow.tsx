/* One Organize row: checkbox · title · artist · album · genre · added ·
   file. A focused click on the words opens the editor; row clicks select —
   no playback in this view, so row click must stay unambiguous. Right-click
   opens the app-wide track menu (Get Info included); on phones, where cells
   are not editable, a tap on the compact row opens Get Info directly. The
   Added and File columns are read-only reference data.

   Drag-reorder: a pressed row that moves past the slop lifts and reorders
   within its album — the grid owns the gesture; the row only wears the
   states (grab cursor when reorderable, dimmed while dragged, displaced
   while neighbors part). */

import type { CSSProperties } from "react";

import type { Track } from "../api/types";
import { fmtBasename, fmtDateShort } from "../lib/format";
import { Artwork } from "./Artwork";
import { InlineEdit } from "./InlineEdit";
import { IconCheck } from "./icons";

const ROW_HEIGHT = 38;

export interface RowMods {
  shiftKey: boolean;
  metaKey: boolean;
  /** Alt joins the selection modifiers. */
  altKey: boolean;
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
  /** Drag-reorder: this row is the one being dragged. */
  dragging?: boolean;
  /** Drag-reorder: the row may start a drag (mouse reorderable album block). */
  draggable?: boolean;
  onToggle: (track: Track, index: number, mods: RowMods) => void;
  onOpenInfo: (track: Track) => void;
  /** Right-click: the app-wide track menu (Get Info's desktop entry). */
  onTrackMenu?: (track: Track, x: number, y: number) => void;
  onCommitTitle: (track: Track, title: string) => void;
  onCommitArtist: (track: Track, artist: string) => void;
  onCommitAlbum: (track: Track, album: string) => void;
  onCommitGenre: (track: Track, genre: string) => void;
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
  dragging = false,
  draggable = false,
  onToggle,
  onOpenInfo,
  onTrackMenu,
  onCommitTitle,
  onCommitArtist,
  onCommitAlbum,
  onCommitGenre,
}: OrganizeRowProps) {
  const classes = [
    "orgrow",
    isCurrent ? "orgrow--playing" : "",
    checked && !isCurrent ? "orgrow--selected" : "",
    isCursor && !checked && !isCurrent ? "orgrow--cursor" : "",
    compact ? "orgrow--compact" : "",
    dragging ? "orgrow--dragging" : "",
    draggable ? "orgrow--draggable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const mods = (e: React.MouseEvent): RowMods => ({
    shiftKey: e.shiftKey,
    metaKey: e.metaKey || e.ctrlKey,
    altKey: e.altKey,
  });

  /* Plain clicks belong to the editable cell (they open its editor);
     modifier-clicks are the row's selection gesture and must reach the
     row: they bubble. The guard sits on the wrapper so it covers the
     editor text and the cell padding alike. */
  const gateCellClick = (e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    e.stopPropagation();
  };

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
          onClick={() =>
            onToggle(track, index, { shiftKey: false, metaKey: false, altKey: false })
          }
        >
          {checked && <IconCheck size={11} />}
        </button>
      </span>
      <span className="orgrow__titlecell" onClick={gateCellClick}>
        {/* Text only: the 24px artwork left the title cell — one icon per
            row read as noise in a mass-editing grid. */}
        <InlineEdit
          value={track.title}
          ariaLabel={`Rename ${track.title}`}
          className="orgrow__titletext"
          startInEdit={editTitle}
          onCommit={(title) => onCommitTitle(track, title)}
        />
      </span>
      <span className="orgrow__cell" onClick={gateCellClick}>
        <InlineEdit
          value={track.artist ?? ""}
          ariaLabel={`Artist for ${track.title}`}
          placeholder="No artist"
          className="orgrow__celltext"
          allowEmpty
          onCommit={(artist) => onCommitArtist(track, artist)}
        />
      </span>
      <span className="orgrow__cell" onClick={gateCellClick}>
        <InlineEdit
          value={track.album ?? ""}
          ariaLabel={`Album for ${track.title}`}
          placeholder="No album"
          className="orgrow__celltext"
          allowEmpty
          onCommit={(album) => onCommitAlbum(track, album)}
        />
      </span>
      <span className="orgrow__cell" onClick={gateCellClick}>
        <InlineEdit
          value={track.genre ?? ""}
          ariaLabel={`Genre for ${track.title}`}
          placeholder="No genre"
          className="orgrow__celltext"
          allowEmpty
          onCommit={(genre) => onCommitGenre(track, genre)}
        />
      </span>
      <span
        className="orgrow__added"
        title={track.added_at ? `Added ${track.added_at}` : undefined}
      >
        {fmtDateShort(track.added_at) ?? "—"}
      </span>
      <span className="orgrow__file" title={track.path}>
        {fmtBasename(track.path)}
      </span>
    </div>
  );
}

export { ROW_HEIGHT };
