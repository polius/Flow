/* Playlist detail — header, mosaic or custom cover, drag-to-reorder tracks
   (§9.2, §9.3, §13.10). Adding tracks opens the in-place Add Tracks picker;
   metadata editing lives behind the Manage dialog; reorder is optimistic and
   the PUT is the source of truth. */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { api } from "../api/client";
import type { PlaylistDetail as PlaylistDetailT, Track } from "../api/types";
import {
  useAddToPlaylist,
  useRemoveFromPlaylist,
  useReorderPlaylist,
} from "../api/mutations";
import { AddTracksDialog } from "../components/AddTracksDialog";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { ManagePlaylistDialog } from "../components/ManagePlaylistDialog";
import { IconPlay, IconPlaylists, IconPlus } from "../components/icons";
import { PlaylistArt } from "../components/PlaylistArt";
import { TrackTable } from "../components/TrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
import { fmtCount, fmtDateTime, fmtMinutes } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { useQueryClient } from "@tanstack/react-query";
import "../styles/library.css";
import "../styles/editing.css";

export function PlaylistDetailView() {
  const playlistId = Number(useParams().playlistId);
  const navigate = useNavigate();
  const playTracks = usePlayerStore((s) => s.playTracks);
  const reorderPlaylist = useReorderPlaylist();
  const removeFromPlaylist = useRemoveFromPlaylist();
  const addToPlaylist = useAddToPlaylist();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  const [managing, setManaging] = useState(false);
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
        <PlaylistArt
          artworkIds={playlist.artwork_ids}
          coverArtworkId={playlist.cover_artwork_id}
          size={220}
          radius="l"
          className="detailhead__art"
        />
        <div className="detailhead__info">
          <p className="detailhead__kind">Playlist</p>
          <h1 className="detailhead__title">{playlist.name}</h1>
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
            <button
              type="button"
              className="btn--primary"
              onClick={() => playTracks(playlist.tracks, 0)}
              disabled={playlist.tracks.length === 0}
            >
              <IconPlay size={15} />
              Play
            </button>
            <button type="button" className="view__action" onClick={() => setAdding(true)}>
              <IconPlus size={14} />
              Add Tracks
            </button>
            <button
              type="button"
              className="view__action"
              onClick={() => setManaging(true)}
            >
              Manage
            </button>
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
            onMove={move}
            onRemoveTrack={(track) => void removeTrack(track)}
          />
        </>
      )}

      {adding && (
        <AddTracksDialog kind="playlist" playlist={playlist} onClose={() => setAdding(false)} />
      )}

      {managing && (
        <ManagePlaylistDialog
          playlist={playlist}
          onClose={() => setManaging(false)}
          onDeleted={() => {
            setManaging(false);
            navigate("/playlists");
          }}
        />
      )}
    </section>
  );
}
