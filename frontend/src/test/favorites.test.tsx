/* Favorite writes: one optimistic pass over every cache shape (infinite
   lists included), one bulk request for a selection, an exact rollback
   when the server answers with an error status (openapi-fetch resolves
   4xx/5xx — nothing throws), and a queue that keeps its identity when no
   queued row changed (no full-queue PUT, no re-centered queue panel). */

import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "../api/types";

const clientApi = vi.hoisted(() => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), use: vi.fn() },
}));
vi.mock("../api/client", () => clientApi);
vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn(() => Promise.resolve({ status: "empty" })),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
}));

import { patchTracksIn, useSetFavoriteMany, useToggleFavorite } from "../api/mutations";
import { usePlayerStore } from "../stores/player";

const track = (id: number, favorite = false): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: 1,
  disc_no: 1,
  year: 2026,
  duration: 60,
  format: "mp3",
  favorite,
  artwork_id: null,
  path: `track-${id}.mp3`,
  gain_db: null,
  played_at: null,
});

const ok = (status = 200) => ({ data: {}, response: new Response(null, { status }) });

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const pagesKey = ["tracks", "all", "", "title", "asc", null];
const pagesOf = (...pages: Track[][]) => ({
  pages: pages.map((items, i) => ({ items, total: 4, offset: i * 2 })),
  pageParams: pages.map((_, i) => i * 2),
});
type Pages = ReturnType<typeof pagesOf>;

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of Object.values(clientApi.api)) fn.mockReset();
  usePlayerStore.setState({ queue: [], order: [], orderPos: 0 });
});

describe("patchTracksIn", () => {
  it("patches infinite-list pages and keeps untouched data identical", () => {
    const data = pagesOf([track(1), track(2)], [track(3), track(4)]);
    const fav = (t: Track) => ({ ...t, favorite: true });
    const next = patchTracksIn(data, new Set([3]), fav) as Pages;
    expect(next.pages[1].items[0].favorite).toBe(true);
    expect(next.pages[0]).toBe(data.pages[0]); // untouched page, same object
    expect(patchTracksIn(data, new Set([99]), fav)).toBe(data);
  });
});

describe("bulk favorite", () => {
  it("one bulk request, one optimistic pass", async () => {
    clientApi.api.POST.mockResolvedValue(ok());
    queryClient.setQueryData(pagesKey, pagesOf([track(1), track(2)], [track(3), track(4)]));
    const { result } = renderHook(() => useSetFavoriteMany(), { wrapper });

    act(() => result.current([track(1), track(3), track(4)], true));
    await flush();

    expect(clientApi.api.POST).toHaveBeenCalledTimes(1);
    expect(clientApi.api.POST).toHaveBeenCalledWith("/api/favorites/bulk", {
      body: { track_ids: [1, 3, 4], favorite: true },
    });
    expect(clientApi.api.PATCH).not.toHaveBeenCalled();
    const data = queryClient.getQueryData<Pages>(pagesKey)!;
    expect(data.pages.flatMap((p) => p.items).map((t) => t.favorite)).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it("rolls back each row to what it was when the server says 500", async () => {
    clientApi.api.POST.mockResolvedValue(ok(500));
    // A mixed selection: 2 was already a favorite.
    queryClient.setQueryData(pagesKey, pagesOf([track(1), track(2, true)]));
    const { result } = renderHook(() => useSetFavoriteMany(), { wrapper });

    act(() => result.current([track(1), track(2, true)], true));
    await flush();

    const data = queryClient.getQueryData<Pages>(pagesKey)!;
    expect(data.pages[0].items.map((t) => t.favorite)).toEqual([false, true]);
  });
});

describe("row heart", () => {
  it("rolls back the cache AND the player queue on an HTTP error", async () => {
    clientApi.api.PATCH.mockResolvedValue(ok(500));
    const queued = track(5);
    usePlayerStore.setState({ queue: [queued], order: [0], orderPos: 0 });
    queryClient.setQueryData(["search", "x"], { tracks: [queued] });
    const { result } = renderHook(() => useToggleFavorite(), { wrapper });

    act(() => result.current(queued));
    await flush();

    expect(usePlayerStore.getState().queue[0].favorite).toBe(false);
    expect(
      queryClient.getQueryData<{ tracks: Track[] }>(["search", "x"])!.tracks[0].favorite,
    ).toBe(false);
  });

  it("leaves the queue array untouched when the track isn't queued", async () => {
    clientApi.api.PATCH.mockResolvedValue(ok());
    const queue = [track(1), track(2)];
    usePlayerStore.setState({ queue, order: [0, 1], orderPos: 0 });
    const { result } = renderHook(() => useToggleFavorite(), { wrapper });

    act(() => result.current(track(9)));
    await flush();

    expect(usePlayerStore.getState().queue).toBe(queue);
  });
});
