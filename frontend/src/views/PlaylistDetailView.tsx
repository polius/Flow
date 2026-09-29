/* Playlist detail — renameable header, mosaic art, drag-to-reorder tracks
   (§9.2, §9.3, §13.10). Reorder is optimistic; the PUT is the source of truth. */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";

import { api } from "../api/client";
import type { PlaylistDetail as PlaylistDetailT } from "../api/types";
import {
  useRemoveFromPlaylist,
  useRenamePlaylist,
  useReorderPlaylist,
} from "../api/mutations";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconPlay, IconPlaylists } from "../components/icons";
import { InlineEdit } from "../components/InlineEdit";
import { PlaylistArt } from "../components/PlaylistArt";
import { TrackTable } from "../components/TrackTable";
import { fmtCount, fmtDateTime, fmtMinutes } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { useQueryClient } from "@tanstack/react-query";
import "../styles/library.css";
import "../styles/editing.css";

export function PlaylistDetailView() {
  const playlistId = Number(useParams().playlistId);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const renamePlaylist = useRenamePlaylist();
  const reorderPlaylist = useReorderPlaylist();
  const removeFromPlaylist = useRemoveFromPlaylist();
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

  return (
    <section className="view">
      <header className="detailhead">
        <PlaylistArt
          artworkIds={playlist.artwork_ids}
          size={220}
          radius="l"
          className="detailhead__art"
        />
        <div className="detailhead__info">
          <p className="detailhead__kind">Playlist</p>
          <h1 className="detailhead__title">
            <InlineEdit
              value={playlist.name}
              ariaLabel="Rename playlist"
              onCommit={(name) => void renamePlaylist(playlistId, { name })}
            />
          </h1>
          <p className="detailhead__meta detailhead__meta--stack">
            <InlineEdit
              value={playlist.description ?? ""}
              placeholder="Add a description…"
              ariaLabel="Edit playlist description"
              multiline
              onCommit={(description) =>
                void renamePlaylist(playlistId, { description })
              }
            />
          </p>
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
          </div>
        </div>
      </header>

      {playlist.tracks.length === 0 ? (
        <EmptyState
          icon={<IconPlaylists size={26} />}
          title="This playlist is empty"
          hint={
            <>
              Find a song in{" "}
              <Link to="/tracks" className="empty-state__link">
                Tracks
              </Link>{" "}
              and use the ··· menu to add it here.
            </>
          }
        />
      ) : (
        <TrackTable
          tracks={playlist.tracks}
          variant="playlist"
          onMove={move}
          onRemoveTrack={(track) => void removeFromPlaylist(playlistId, track.id)}
        />
      )}
    </section>
  );
}
