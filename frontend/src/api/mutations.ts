/* Shared server mutations: optimistic cache updates + invalidate on settle.
   The player queue is patched in place so a playing track's heart stays live. */

import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";

import { api } from "./client";
import { invalidateLibrary } from "./queryClient";
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

/** Every cache family that can hold track rows. */
const TRACK_CACHES: QueryKey[] = [["tracks"], ["album"], ["artist"], ["playlist"], ["search"]];

/** `fn` over the rows of `list` whose id is in `ids`. The same array comes
    back when no row changed — identity is what tells React, the cache and
    the queue mirror that nothing happened. */
function patchList<T>(list: T[], ids: ReadonlySet<number>, fn: (track: Track) => Track): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < list.length; i++) {
    const t = list[i] as unknown;
    if (t == null || typeof t !== "object" || !ids.has((t as Track).id)) continue;
    const next = fn(t as Track);
    if (next === t) continue;
    out ??= list.slice();
    out[i] = next as T;
  }
  return out ?? list;
}

/** Apply `fn` to the matching tracks inside the common response shapes:
    flat lists (`items` / `tracks`) and infinite lists (`pages[].items`).
    Untouched data keeps its identity. */
export function patchTracksIn(
  data: unknown,
  ids: ReadonlySet<number>,
  fn: (track: Track) => Track,
): unknown {
  if (data == null || typeof data !== "object") return data;
  const src = data as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const key of ["items", "tracks"]) {
    const list = src[key];
    if (!Array.isArray(list)) continue;
    const patched = patchList(list as unknown[], ids, fn);
    if (patched !== list) {
      next ??= { ...src };
      next[key] = patched;
    }
  }
  // Infinite lists (Tracks, Favorites): { pages: [{ items, … }], pageParams }.
  if (Array.isArray(src.pages)) {
    const pages = src.pages as unknown[];
    const patched = pages.map((page) => patchTracksIn(page, ids, fn));
    if (patched.some((page, i) => page !== pages[i])) {
      next ??= { ...src };
      next.pages = patched;
    }
  }
  return next ?? data;
}

/** Apply `fn` to the given tracks wherever they sit: every track cache
    and the player queue — one pass over each, whatever the selection
    size. A queue with no matching row keeps its identity: no full-queue
    PUT, no re-centered queue panel. */
function patchTracks(
  queryClient: QueryClient,
  ids: ReadonlySet<number>,
  fn: (track: Track) => Track,
): void {
  for (const queryKey of TRACK_CACHES) {
    queryClient.setQueriesData<unknown>({ queryKey }, (data: unknown) =>
      patchTracksIn(data, ids, fn),
    );
  }
  usePlayerStore.setState((s) => {
    const queue = patchList(s.queue, ids, fn);
    return queue === s.queue ? s : { queue };
  });
}

/** The bulk endpoint's per-request cap. */
const BULK_FAVORITE_MAX = 50_000;

async function writeFavorites(ids: number[], favorite: boolean): Promise<boolean> {
  try {
    if (ids.length === 1) {
      const { response } = await api.PATCH("/api/tracks/{track_id}", {
        params: { path: { track_id: ids[0] } },
        body: { favorite },
      });
      return response.ok;
    }
    for (let i = 0; i < ids.length; i += BULK_FAVORITE_MAX) {
      const { response } = await api.POST("/api/favorites/bulk", {
        body: { track_ids: ids.slice(i, i + BULK_FAVORITE_MAX), favorite },
      });
      if (!response.ok) return false;
    }
    return true;
  } catch {
    return false; // offline: the network threw before any status existed
  }
}

/** One favorite write for any number of tracks, shared by the row heart,
    the selection bar, and every undo: one optimistic pass, one request
    (the bulk endpoint past a single track), an exact rollback when the
    server says no — openapi-fetch resolves 4xx/5xx instead of throwing,
    so the status is checked, not caught — and one refetch: only the
    Favorites list changes membership; every other list already shows the
    patched heart. Resolves to whether the write landed. */
async function setFavorites(
  queryClient: QueryClient,
  tracks: Track[],
  favorite: boolean,
): Promise<boolean> {
  if (tracks.length === 0) return true;
  const ids = new Set(tracks.map((t) => t.id));
  // What each row was before: a mixed selection rolls back to its mix.
  const before = new Map(tracks.map((t) => [t.id, t.favorite]));
  // A refetch already in flight would land over the optimistic patch with
  // pre-write rows. Cancel those (only those — cancelling a first load
  // would strand its skeleton) and re-ask once the write has settled.
  const inFlight = TRACK_CACHES.flatMap((queryKey) =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey })
      .filter((q) => q.state.fetchStatus === "fetching" && q.state.data !== undefined),
  );
  await Promise.all(
    inFlight.map((q) => queryClient.cancelQueries({ queryKey: q.queryKey, exact: true })),
  );
  patchTracks(queryClient, ids, (t) => (t.favorite === favorite ? t : { ...t, favorite }));
  const ok = await writeFavorites([...ids], favorite);
  if (!ok) {
    patchTracks(queryClient, ids, (t) => {
      const was = before.get(t.id);
      return was == null || t.favorite === was ? t : { ...t, favorite: was };
    });
    useUiStore.getState().showUndoNotice({
      message: "Couldn’t update Favorites. Try again.",
    });
  }
  for (const q of inFlight) {
    void queryClient.invalidateQueries({ queryKey: q.queryKey, exact: true });
  }
  void queryClient.invalidateQueries({ queryKey: ["tracks", "favorites"] });
  return ok;
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  return (track: Track) => {
    const favorite = !track.favorite;
    void setFavorites(queryClient, [track], favorite).then((ok) => {
      // Un-favoriting is a removal: offer Undo once it landed; favoriting
      // is a gain and stays quiet. The undo rides the same write path, so
      // the optimistic patch and the server call can't diverge.
      if (ok && !favorite) {
        showUndoNotice({
          message: `Removed “${track.title}” from Favorites`,
          undo: async () => {
            await setFavorites(queryClient, [{ ...track, favorite: false }], true);
          },
        });
      }
    });
  };
}

/** Batch favorite from the selection bar: one optimistic pass, one bulk
    request, one undo toast for the whole batch; favoriting stays quiet. */
export function useSetFavoriteMany() {
  const queryClient = useQueryClient();
  const showUndoNotice = useUiStore((s) => s.showUndoNotice);
  return (tracks: Track[], favorite: boolean) => {
    if (tracks.length === 0) return;
    void setFavorites(queryClient, tracks, favorite).then((ok) => {
      if (ok && !favorite) {
        const label =
          tracks.length === 1 ? `“${tracks[0].title}”` : `${tracks.length} tracks`;
        showUndoNotice({
          message: `Removed ${label} from Favorites`,
          undo: async () => {
            // Restore exactly the rows that were favorites before.
            await setFavorites(
              queryClient,
              tracks.filter((t) => t.favorite).map((t) => ({ ...t, favorite: false })),
              true,
            );
          },
        });
      }
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
      // A rename can move any list, grid, count or review group.
      invalidateLibrary(queryClient);
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
    invalidateLibrary(queryClient);
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
    invalidateLibrary(queryClient);
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
    try {
      const { response } = await api.DELETE(
        "/api/playlists/{playlist_id}/tracks/{track_id}",
        { params: { path: { playlist_id: playlistId, track_id: trackId } } },
      );
      // The caller offers Undo only when the removal landed; a failure
      // surfaces through this throw.
      if (!response.ok) throw new Error("Failed to remove track from playlist");
    } finally {
      // Landed or not, the server's list is the truth: a failed removal
      // must put the optimistically dropped row back.
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
      void queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    }
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
