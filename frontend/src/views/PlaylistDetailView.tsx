/* Playlist detail — header, mosaic or custom cover, drag-to-reorder tracks
   (§9.2, §9.3, §13.10). Adding tracks opens the in-place Add Tracks picker;
   reorder is optimistic and the PUT is the source of truth.

   Editing lives in the header (2026-10-03): the name and the cover are
   click-to-edit in place — the Manage dialog is gone. The cover button
   uploads a new image (the scrim reveals on hover/focus) and its corner ×
   removes a custom cover; deletion lives in the "…" menu behind a two-step
   confirm. */

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { api } from "../api/client";
import type { PlaylistDetail as PlaylistDetailT, QueueOrigin, Track } from "../api/types";
import {
  useAddToPlaylist,
  useDeletePlaylist,
  useRemoveFromPlaylist,
  useReorderPlaylist,
  useUpdatePlaylist,
  useUploadPlaylistCover,
} from "../api/mutations";
import { AddTracksDialog } from "../components/AddTracksDialog";
import { CollectionActions } from "../components/CollectionActions";
import { EmptyState } from "../components/EmptyState";
import { InlineEdit } from "../components/InlineEdit";
import { LoadingState } from "../components/LoadingState";
import { IconClose, IconPlaylists, IconPlus, IconTrash } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { TrackTable } from "../components/TrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
import { fmtCount, fmtDateTime, fmtMinutes } from "../lib/format";
import { useUiStore } from "../stores/ui";
import { useQueryClient } from "@tanstack/react-query";
import "../styles/library.css";
import "../styles/editing.css";

/** The header cover is its own edit affordance: click changes the image,
    the corner × removes a custom one (the mosaic takes back over). */
function PlaylistCoverCell({ playlist }: { playlist: PlaylistDetailT }) {
  const uploadCover = useUploadPlaylistCover();
  const updatePlaylist = useUpdatePlaylist();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasCover = playlist.cover_artwork_id != null;

  const onPick = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    await uploadCover(playlist.id, file);
    setUploading(false);
  };

  return (
    <div className="detailhead__artcol">
      <button
        type="button"
        className={`detailhead__artbutton${uploading ? " detailhead__artbutton--busy" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        aria-label={hasCover ? "Change cover image" : "Add cover image"}
        title="JPEG or PNG, up to 10 MB"
      >
        <PlaylistArt
          artworkIds={playlist.artwork_ids}
          coverArtworkId={playlist.cover_artwork_id}
          size={220}
          radius="l"
          className="detailhead__art"
        />
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
          onClick={() => void updatePlaylist(playlist.id, { cover_artwork_id: null })}
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

export function PlaylistDetailView() {
  const playlistId = Number(useParams().playlistId);
  const navigate = useNavigate();
  const reorderPlaylist = useReorderPlaylist();
  const removeFromPlaylist = useRemoveFromPlaylist();
  const addToPlaylist = useAddToPlaylist();
  const updatePlaylist = useUpdatePlaylist();
  const deletePlaylist = useDeletePlaylist();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();

  const { data: playlist } = useQuery({
    queryKey: ["playlist", playlistId],
    queryFn: async () => {
      const { data, response } = await api.GET("/api/playlists/{playlist_id}", {
        params: { path: { playlist_id: playlistId } },
      });
      if (!response.ok) return null;
      return data;
    },
    enabled: Number.isFinite(playlistId),
  });

  if (playlist === null) {
    return (
      <section className="view">
        <EmptyState
          icon={<IconPlaylists size={26} />}
          title="Playlist not found"
          hint="It may have been deleted."
        />
      </section>
    );
  }

  if (playlist === undefined) {
    return (
      <section className="view">
        <LoadingState variant="detail" />
      </section>
    );
  }

  // §1.1: the playlist is the queue's origin — playing it says so, and
  // every row click here inherits the same sentence.
  const playlistOrigin: QueueOrigin = {
    kind: "playlist",
    label: playlist.name,
    href: `/playlists/${playlist.id}`,
  };

  const move = (fromIndex: number, toIndex: number) => {
    const ids = playlist.tracks.map((t) => t.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    // Optimistic rewrite of the cached detail; server confirms behind it.
    const optimistic = {
      ...playlist,
      tracks: ids.map((id, i) => {
        const row = playlist.tracks.find((t) => t.id === id)!;
        return { ...row, position: i + 1 };
      }),
    };
    queryClient.setQueryData<PlaylistDetailT>(["playlist", playlistId], optimistic);
    void reorderPlaylist(playlistId, ids);
  };

  const metaBits = [
    `${fmtCount(playlist.track_count)} track${playlist.track_count === 1 ? "" : "s"}`,
    playlist.track_count > 0 ? fmtMinutes(playlist.duration_total) : null,
    fmtDateTime(playlist.created_at),
  ].filter(Boolean);

  // Removal (§25): no confirmation — a frequent, low-stakes action recovers
  // by undo, not by dialog. The position is snapshotted now; the undo
  // closure re-adds the track and PUTs the order back, inserting at that
  // slot of whatever the list looks like when Undo is pressed (so reorders
  // made after the removal survive).
  const removeTrack = async (track: Track) => {
    const index = playlist.tracks.findIndex((t) => t.id === track.id);
    try {
      await removeFromPlaylist(playlistId, track.id);
    } catch {
      return; // the mutation's invalidate resyncs the optimistic row
    }
    showUndoNotice({
      message: `Removed “${track.title}” from this playlist`,
      undo: async () => {
        // Re-add appends to the end; the order PUT restores the original slot.
        await addToPlaylist(playlistId, [track.id]);
        const { data } = await api.GET("/api/playlists/{playlist_id}", {
          params: { path: { playlist_id: playlistId } },
        });
        if (!data) return;
        const ids = data.tracks.map((t) => t.id).filter((id) => id !== track.id);
        ids.splice(Math.min(Math.max(index, 0), ids.length), 0, track.id);
        await reorderPlaylist(playlistId, ids);
      },
    });
  };

  return (
    <section className="view">
      <header className="detailhead">
        <PlaylistCoverCell playlist={playlist} />
        <div className="detailhead__info">
          <p className="detailhead__kind">Playlist</p>
          {/* The name is click-to-edit (2026-10-03): Enter commits, Esc
              cancels — the Organize grid's inline grammar (§15.1). */}
          <h1 className="detailhead__titlerow">
            <InlineEdit
              value={playlist.name}
              onCommit={(name) => void updatePlaylist(playlist.id, { name })}
              className="detailhead__title"
              ariaLabel="Rename playlist"
            />
          </h1>
          {playlist.description && (
            <p className="detailhead__meta detailhead__meta--stack">
              {playlist.description}
            </p>
          )}
          <p className="detailhead__meta">
            {metaBits.map((bit, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {bit}
              </span>
            ))}
          </p>
          <div className="detailhead__actions">
            {/* §2.1: the playlist joins the §30.1 header trio — Play ·
                Shuffle · … — shared with album/artist detail so the grammar
                cannot fork. Add Tracks stays in the "…" menu; deletion is
                there too now, behind the two-step confirm (2026-10-03) —
                the editing dialog is gone, its verbs live in the page. */}
            <CollectionActions
              tracks={playlist.tracks}
              label={playlist.name}
              origin={playlistOrigin}
              extraItems={[
                {
                  label: "Add Tracks",
                  icon: <IconPlus size={15} />,
                  onSelect: () => setAdding(true),
                },
                {
                  label: "Delete Playlist",
                  icon: <IconTrash size={15} />,
                  danger: true,
                  confirmLabel: "Confirm Delete",
                  onSelect: () => {
                    void deletePlaylist(playlist.id).then((ok) => {
                      if (ok) navigate("/playlists");
                    });
                  },
                },
              ]}
            />
          </div>
        </div>
      </header>

      {playlist.tracks.length === 0 ? (
        <EmptyState
          icon={<IconPlaylists size={26} />}
          title="This playlist is empty"
          hint={
            <>
              Search your library right here — pick a song, an album, anything.{" "}
              <button type="button" className="empty-state__link" onClick={() => setAdding(true)}>
                Add your first tracks
              </button>
            </>
          }
        />
      ) : (
        <>
          <TrackTableHead variant="playlist" />
          <TrackTable
            tracks={playlist.tracks}
            variant="playlist"
            origin={playlistOrigin}
            onMove={move}
            onRemoveTrack={(track) => void removeTrack(track)}
          />
        </>
      )}

      {adding && (
        <AddTracksDialog kind="playlist" playlist={playlist} onClose={() => setAdding(false)} />
      )}
    </section>
  );
}
