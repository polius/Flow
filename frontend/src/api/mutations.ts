/* Shared server mutations: optimistic cache updates + invalidate on settle.
   The player queue is patched in place so a playing track's heart stays live. */

import { useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import type {
  AlbumDetail,
  ArtistDetail,
  BulkApplyIn,
  PlaylistDetail,
  Track,
  TrackPatch,
} from "./types";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

/** Apply `fn` to a track wherever it sits inside the common response shapes. */
function patchEverywhere(
  queryClient: ReturnType<typeof useQueryClient>,
  trackId: number,
  fn: (track: Track) => Track,
): void {
  queryClient.setQueriesData<unknown>({ queryKey: ["tracks"] }, (data: unknown) =>
    patchTracksIn(data, trackId, fn),
  );
  queryClient.setQueriesData<unknown>({ queryKey: ["album"] }, (data: unknown) =>
    patchTracksIn(data, trackId, fn),
  );
  queryClient.setQueriesData<unknown>({ queryKey: ["artist"] }, (data: unknown) =>
    patchTracksIn(data, trackId, fn),
  );
  queryClient.setQueriesData<unknown>({ queryKey: ["playlist"] }, (data: unknown) =>
    patchTracksIn(data, trackId, fn),
  );
  queryClient.setQueriesData<unknown>({ queryKey: ["search"] }, (data: unknown) =>
    patchTracksIn(data, trackId, fn),
  );
  usePlayerStore.setState((s) => ({
    queue: s.queue.map((t) => (t.id === trackId ? fn(t) : t)),
  }));
}

function patchTracksIn(
  data: unknown,
  trackId: number,
  fn: (track: Track) => Track,
): unknown {
  if (data == null || typeof data !== "object") return data;
  const next = { ...(data as Record<string, unknown>) };
  let touched = false;
  for (const key of ["items", "tracks"]) {
    const list = next[key];
    if (Array.isArray(list)) {
      next[key] = list.map((t: unknown) =>
        t && typeof t === "object" && (t as Track).id === trackId
          ? fn(t as Track)
          : t,
      );
      touched = true;
    }
  }
  return touched ? next : data;
}

/** One favorite toggle, shared by the hook and the undo closure: optimistic
    patch everywhere, server call, rollback + refetch on failure. */
function applyFavorite(
  queryClient: ReturnType<typeof useQueryClient>,
  trackId: number,
  favorite: boolean,
): void {
  patchEverywhere(queryClient, trackId, (t) => ({ ...t, favorite }));
  void api
    .PATCH("/api/tracks/{track_id}", {
      params: { path: { track_id: trackId } },
      body: { favorite },
    })
    .then(() => {
      void queryClient.invalidateQueries({ queryKey: ["tracks"] });
    })
    .catch(() => {
      // Roll back on failure; refetch tells the truth.
      patchEverywhere(queryClient, trackId, (t) => ({
        ...t,
        favorite: !favorite,
      }));
    });
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  return (track: Track) => {
    const favorite = !track.favorite;
    applyFavorite(queryClient, track.id, favorite);
    // Un-favoriting is a removal: offer Undo at once; favoriting is a
    // gain and stays quiet. The undo rides the same toggle path, so the
    // optimistic patch and the server call can't diverge.
    if (!favorite) {
      showUndoNotice({
        message: `Removed “${track.title}” from Favorites`,
        undo: async () => {
          applyFavorite(queryClient, track.id, true);
        },
      });
    }
  };
}

/** Batch favorite from the selection bar: one undo toast restores the
    whole batch; favoriting stays quiet. Each track rides the same
    applyFavorite the row heart uses, so queue and caches stay in step.
    Deliberately N single PATCHes at selection scale, not a new endpoint. */
export function useSetFavoriteMany() {
  const queryClient = useQueryClient();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  return (tracks: Track[], favorite: boolean) => {
    if (tracks.length === 0) return;
    for (const t of tracks) applyFavorite(queryClient, t.id, favorite);
    if (!favorite) {
      const label =
        tracks.length === 1 ? `“${tracks[0].title}”` : `${tracks.length} tracks`;
      showUndoNotice({
        message: `Removed ${label} from Favorites`,
        undo: async () => {
          for (const t of tracks) applyFavorite(queryClient, t.id, true);
        },
      });
    }
  };
}

export function usePatchTrack() {
  const queryClient = useQueryClient();
  return async (trackId: number, patch: TrackPatch): Promise<boolean> => {
    const { response } = await api.PATCH("/api/tracks/{track_id}", {
      params: { path: { track_id: trackId } },
      body: patch,
    });
    if (response.ok) {
      void queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void queryClient.invalidateQueries({ queryKey: ["album"] });
      void queryClient.invalidateQueries({ queryKey: ["artist"] });
      void queryClient.invalidateQueries({ queryKey: ["playlist"] });
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
      void queryClient.invalidateQueries({ queryKey: ["genres"] });
      // Regrouping can change every review count.
      void queryClient.invalidateQueries({ queryKey: ["review"] });
      return true;
    }
    return false;
  };
}

/** Mass apply + one-generation undo. Both invalidate broadly — albums,
    artists, and every review count can move at once. */
export function useBulkApply() {
  const queryClient = useQueryClient();
  return async (body: BulkApplyIn): Promise<number | null> => {
    const { data, response } = await api.POST("/api/tracks/bulk", { body });
    if (!response.ok || !data) return null;
    void queryClient.invalidateQueries({ queryKey: ["tracks"] });
    void queryClient.invalidateQueries({ queryKey: ["album"] });
    void queryClient.invalidateQueries({ queryKey: ["artist"] });
    void queryClient.invalidateQueries({ queryKey: ["playlist"] });
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    void queryClient.invalidateQueries({ queryKey: ["genres"] });
    void queryClient.invalidateQueries({ queryKey: ["review"] });
    return data.applied;
  };
}

/** Undo the last library edit. One generation, server-side, overwritten by
    every write — single PATCH, bulk apply, drag-reorder — so the toast
    pill's Undo and Organize's ⌘Z are two doors to the same room. On
    success the pill quietly restates the outcome: restored, not updated. */
export function useUndoTrackEdit() {
  const queryClient = useQueryClient();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  return async (): Promise<number | null> => {
    const { data, response } = await api.POST("/api/tracks/bulk/undo");
    if (!response.ok || !data) return null;
    void queryClient.invalidateQueries({ queryKey: ["tracks"] });
    void queryClient.invalidateQueries({ queryKey: ["album"] });
    void queryClient.invalidateQueries({ queryKey: ["artist"] });
    void queryClient.invalidateQueries({ queryKey: ["playlist"] });
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    void queryClient.invalidateQueries({ queryKey: ["genres"] });
    void queryClient.invalidateQueries({ queryKey: ["review"] });
    if (data.applied > 0) {
      showUndoNotice({
        message: `Restored ${data.applied.toLocaleString()} ${data.applied === 1 ? "track" : "tracks"}`,
      });
    }
    return data.applied;
  };
}

/** Drag-reorder: one album's tracks in their new order — the server
    renumbers 1..n and flags each overlay-edited. The reorder lands in the
    same undo generation as any edit, so the pill's Undo puts the numbers
    back (used by Organize's grid and the album page alike). */
export function useReorderTracks() {
  const queryClient = useQueryClient();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  const undoEdit = useUndoTrackEdit();
  return async (trackIds: number[]): Promise<boolean> => {
    const { data, response } = await api.POST("/api/tracks/reorder", {
      body: { track_ids: trackIds },
    });
    if (response.ok) {
      void queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void queryClient.invalidateQueries({ queryKey: ["review"] });
      if ((data?.applied ?? 0) > 0) {
        showUndoNotice({
          message: `Reordered ${data!.applied.toLocaleString()} ${data!.applied === 1 ? "track" : "tracks"}`,
          undo: async () => {
            await undoEdit();
          },
        });
      }
    }
    return response.ok;
  };
}

/** Favorites drag-reorder: the whole favorites list in its new order —
    the server rewrites each favorite_position 1..n. The caller applies
    the optimistic splice; the invalidate resyncs what the caller's cache
    couldn't know. */
export function useReorderFavorites() {
  const queryClient = useQueryClient();
  return async (trackIds: number[]): Promise<boolean> => {
    const { response } = await api.POST("/api/favorites/reorder", {
      body: { track_ids: trackIds },
    });
    if (response.ok) {
      void queryClient.invalidateQueries({ queryKey: ["tracks"] });
    }
    return response.ok;
  };
}

export function useCreatePlaylist() {
  const queryClient = useQueryClient();
  return async (name = "New Playlist"): Promise<PlaylistDetail | null> => {
    const { data, response } = await api.POST("/api/playlists", {
      body: { name },
    });
    if (!response.ok || !data) return null;
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    return data;
  };
}

export function useAddToPlaylist() {
  const queryClient = useQueryClient();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  return async (playlistId: number, trackIds: number[]): Promise<boolean> => {
    const { response } = await api.POST("/api/playlists/{playlist_id}/tracks", {
      params: { path: { playlist_id: playlistId } },
      body: { track_ids: trackIds },
    });
    if (response.ok) {
      // The server skips tracks the playlist already holds; the headers
      // carry the honest split — say so, or a "0 added" add would look
      // like a lie.
      const added = Number(response.headers.get("x-tracks-added") ?? trackIds.length);
      const skipped = Number(response.headers.get("x-tracks-skipped") ?? 0);
      if (skipped > 0) {
        const parts = [`Added ${added} ${added === 1 ? "track" : "tracks"}`];
        if (added === 0) parts[0] = "Already in this playlist";
        else parts.push(`${skipped} already ${skipped === 1 ? "was" : "were"} in it`);
        showUndoNotice({ message: parts.join(" · ") });
      }
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
      void queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    }
    return response.ok;
  };
}

export function useRemoveFromPlaylist() {
  const queryClient = useQueryClient();
  return async (playlistId: number, trackId: number): Promise<void> => {
    // Optimistic: drop every occurrence from the cached detail.
    queryClient.setQueryData<PlaylistDetail>(["playlist", playlistId], (d) => {
      if (!d) return d;
      const remaining = d.tracks.filter((t) => t.id !== trackId);
      return {
        ...d,
        tracks: remaining.map((t, i) => ({ ...t, position: i + 1 })),
        track_count: remaining.length,
      };
    });
    const { response } = await api.DELETE(
      "/api/playlists/{playlist_id}/tracks/{track_id}",
      { params: { path: { playlist_id: playlistId, track_id: trackId } } },
    );
    // The caller offers Undo only when the removal landed; a failure
    // surfaces through this throw and the invalidate below resyncs the row.
    if (!response.ok) throw new Error("Failed to remove track from playlist");
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
  };
}

export function useReorderPlaylist() {
  const queryClient = useQueryClient();
  return async (
    playlistId: number,
    trackIds: number[],
  ): Promise<void> => {
    await api.PUT("/api/playlists/{playlist_id}/order", {
      params: { path: { playlist_id: playlistId } },
      body: { track_ids: trackIds },
    });
    void queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
  };
}

export function useUpdatePlaylist() {
  const queryClient = useQueryClient();
  return async (
    playlistId: number,
    body: {
      name?: string;
      description?: string | null;
      cover_artwork_id?: number | null;
    },
  ): Promise<boolean> => {
    const { response } = await api.PATCH("/api/playlists/{playlist_id}", {
      params: { path: { playlist_id: playlistId } },
      body,
    });
    if (response.ok) {
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
      void queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    }
    return response.ok;
  };
}

export function useUploadPlaylistCover() {
  const queryClient = useQueryClient();
  return async (playlistId: number, file: File): Promise<PlaylistDetail | null> => {
    // openapi-typescript types multipart bodies as { file: string }; the
    // runtime contract is FormData (hand-built here).
    const form = new FormData();
    form.append("file", file);
    const { data, response } = await api.PUT("/api/playlists/{playlist_id}/cover", {
      params: { path: { playlist_id: playlistId } },
      body: form as unknown as { file: string },
    });
    if (!response.ok || !data) return null;
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    return data;
  };
}

export function useDeletePlaylist() {
  const queryClient = useQueryClient();
  return async (playlistId: number): Promise<boolean> => {
    const { response } = await api.DELETE("/api/playlists/{playlist_id}", {
      params: { path: { playlist_id: playlistId } },
    });
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    return response.ok;
  };
}

/** Album & artist covers mirror the playlist cover contract: PUT stores
    an upload, DELETE restores the derived art. The artist-page hooks also
    refresh ["albums"]: its grid embeds album cards that read the album's
    own override. */
function invalidateAlbumCovers(
  queryClient: ReturnType<typeof useQueryClient>,
  albumId: number,
): void {
  void queryClient.invalidateQueries({ queryKey: ["album", albumId] });
  void queryClient.invalidateQueries({ queryKey: ["albums"] });
  void queryClient.invalidateQueries({ queryKey: ["artist"] });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
}

export function useUploadAlbumCover() {
  const queryClient = useQueryClient();
  return async (albumId: number, file: File): Promise<AlbumDetail | null> => {
    // openapi-typescript types multipart bodies as { file: string }; the
    // runtime contract is FormData (hand-built here), as the playlist's.
    const form = new FormData();
    form.append("file", file);
    const { data, response } = await api.PUT("/api/albums/{album_id}/cover", {
      params: { path: { album_id: albumId } },
      body: form as unknown as { file: string },
    });
    if (!response.ok || !data) return null;
    invalidateAlbumCovers(queryClient, albumId);
    return data;
  };
}

export function useRemoveAlbumCover() {
  const queryClient = useQueryClient();
  return async (albumId: number): Promise<AlbumDetail | null> => {
    const { data, response } = await api.DELETE("/api/albums/{album_id}/cover", {
      params: { path: { album_id: albumId } },
    });
    if (!response.ok || !data) return null;
    invalidateAlbumCovers(queryClient, albumId);
    return data;
  };
}

function invalidateArtistCovers(
  queryClient: ReturnType<typeof useQueryClient>,
  artistId: number,
): void {
  void queryClient.invalidateQueries({ queryKey: ["artist", artistId] });
  void queryClient.invalidateQueries({ queryKey: ["artists"] });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
}

export function useUploadArtistCover() {
  const queryClient = useQueryClient();
  return async (artistId: number, file: File): Promise<ArtistDetail | null> => {
    const form = new FormData();
    form.append("file", file);
    const { data, response } = await api.PUT("/api/artists/{artist_id}/cover", {
      params: { path: { artist_id: artistId } },
      body: form as unknown as { file: string },
    });
    if (!response.ok || !data) return null;
    invalidateArtistCovers(queryClient, artistId);
    return data;
  };
}

export function useRemoveArtistCover() {
  const queryClient = useQueryClient();
  return async (artistId: number): Promise<ArtistDetail | null> => {
    const { data, response } = await api.DELETE("/api/artists/{artist_id}/cover", {
      params: { path: { artist_id: artistId } },
    });
    if (!response.ok || !data) return null;
    invalidateArtistCovers(queryClient, artistId);
    return data;
  };
}

/** Cover removal's undo path: re-point the cover at the artwork row the
    removal cleared. The `artwork` table is content-addressed and unpruned,
    so restoring is one reference write, not a re-upload. */
export function useUpdateAlbum() {
  const queryClient = useQueryClient();
  return async (
    albumId: number,
    body: { cover_artwork_id?: number | null },
  ): Promise<boolean> => {
    const { response } = await api.PATCH("/api/albums/{album_id}", {
      params: { path: { album_id: albumId } },
      body,
    });
    if (response.ok) invalidateAlbumCovers(queryClient, albumId);
    return response.ok;
  };
}

export function useUpdateArtist() {
  const queryClient = useQueryClient();
  return async (
    artistId: number,
    body: { cover_artwork_id?: number | null },
  ): Promise<boolean> => {
    const { response } = await api.PATCH("/api/artists/{artist_id}", {
      params: { path: { artist_id: artistId } },
      body,
    });
    if (response.ok) invalidateArtistCovers(queryClient, artistId);
    return response.ok;
  };
}
