/* Server mutations shared by the M4 editing surfaces (§11.4).
   Each hook keeps optimistic cache updates local and invalidates on settle —
   list views re-render from server truth, the player queue is patched in
   place so a playing track's heart stays live. */

import { useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import type { BulkApplyIn, PlaylistDetail, Track, TrackPatch } from "./types";
import { usePlayerStore } from "../stores/player";

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
      next[key] = list.map((t) =>
        t && typeof t === "object" && (t as Track).id === trackId
          ? fn(t as Track)
          : t,
      );
      touched = true;
    }
  }
  return touched ? next : data;
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  return (track: Track) => {
    const favorite = !track.favorite;
    patchEverywhere(queryClient, track.id, (t) => ({ ...t, favorite }));
    void api
      .PATCH("/api/tracks/{track_id}", {
        params: { path: { track_id: track.id } },
        body: { favorite },
      })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["tracks"] });
      })
      .catch(() => {
        // Roll back on failure; refetch tells the truth.
        patchEverywhere(queryClient, track.id, (t) => ({
          ...t,
          favorite: !favorite,
        }));
      });
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
      // Regrouping can change every review count (§22).
      void queryClient.invalidateQueries({ queryKey: ["review"] });
      return true;
    }
    return false;
  };
}

/** Organize view (§22): mass apply + one-generation undo. Both invalidate
    broadly — albums, artists, and every review count can move at once. */
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
    void queryClient.invalidateQueries({ queryKey: ["review"] });
    return data.applied;
  };
}

export function useUndoBulkApply() {
  const queryClient = useQueryClient();
  return async (): Promise<number | null> => {
    const { data, response } = await api.POST("/api/tracks/bulk/undo");
    if (!response.ok || !data) return null;
    void queryClient.invalidateQueries({ queryKey: ["tracks"] });
    void queryClient.invalidateQueries({ queryKey: ["album"] });
    void queryClient.invalidateQueries({ queryKey: ["artist"] });
    void queryClient.invalidateQueries({ queryKey: ["playlist"] });
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    void queryClient.invalidateQueries({ queryKey: ["review"] });
    return data.applied;
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
  return async (playlistId: number, trackIds: number[]): Promise<boolean> => {
    const { response } = await api.POST("/api/playlists/{playlist_id}/tracks", {
      params: { path: { playlist_id: playlistId } },
      body: { track_ids: trackIds },
    });
    if (response.ok) {
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
    await api.DELETE("/api/playlists/{playlist_id}/tracks/{track_id}", {
      params: { path: { playlist_id: playlistId, track_id: trackId } },
    });
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
