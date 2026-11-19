/* Smaller data-flow guarantees: the row menu's Play is the row click
   (one whole-view request, not a page-by-page fetch), a failed playlist
   removal puts the optimistically dropped row back, a reorder that did
   not save goes back and says so, a rename reaches the song that is
   playing, and Home's "Recently added" shelf asks for the newest albums. */

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import {
  usePatchTrack,
  useRemoveFromPlaylist,
  useReorderFavorites,
  useReorderPlaylist,
  useReorderTracks,
} from "../api/mutations";
import { usePlayerStore } from "../stores/player";
import { HomeView } from "../views/HomeView";
import { TrackActionsMenu } from "../components/TrackActionsMenu";
import { useUiStore } from "../stores/ui";

window.matchMedia ??=
  ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;

const track = (id: number): Track => ({
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
  favorite: false,
  artwork_id: null,
  path: `track-${id}.mp3`,
  gain_db: null,
  played_at: null,
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ trackMenu: null });
});

describe("row menu Play", () => {
  it("runs the table's own play path instead of loading every page", () => {
    const playFrom = vi.fn();
    const contextLoader = vi.fn(() => Promise.resolve([track(1)]));
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <TrackActionsMenu />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // Opened after mount: the host closes any menu on navigation.
    act(() => {
      useUiStore.setState({
        trackMenu: { track: track(1), x: 0, y: 0, context: [track(1)], contextLoader, playFrom },
      });
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Play" }));
    expect(playFrom).toHaveBeenCalledTimes(1);
    expect(contextLoader).not.toHaveBeenCalled();
  });
});

describe("playlist removal", () => {
  it("re-reads the playlist when the removal fails", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(["playlist", 4], {
      tracks: [{ ...track(1), position: 1 }],
      track_count: 1,
    });
    clientApi.api.DELETE.mockResolvedValue({ response: new Response(null, { status: 500 }) });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRemoveFromPlaylist(), { wrapper });

    await act(async () => {
      await expect(result.current(4, 1)).rejects.toThrow();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["playlist", 4] });
  });
});

describe("Home's Recently added shelf", () => {
  it("asks for the newest albums first", async () => {
    clientApi.api.GET.mockResolvedValue({ data: undefined });
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <HomeView />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    type Call = [string, { params?: { query?: { sort?: string; dir?: string } } }?];
    const recent = (clientApi.api.GET.mock.calls as Call[]).find(
      ([path, init]) => path === "/api/albums" && init?.params?.query?.sort === "recent",
    );
    expect(recent?.[1]?.params?.query?.dir).toBe("desc");
  });
});

describe("a reorder that does not save", () => {
  const setup = () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    useUiStore.setState({ undoNotice: null });
    return { invalidate, wrapper };
  };
  const failed = () => Promise.resolve({ response: new Response(null, { status: 500 }) });
  const offline = () => Promise.reject(new TypeError("Failed to fetch"));

  it("Favorites: the list is re-read and the listener is told, on an error or no answer", async () => {
    for (const answer of [failed, offline]) {
      const { invalidate, wrapper } = setup();
      clientApi.api.POST.mockImplementation(answer);
      const { result } = renderHook(() => useReorderFavorites(), { wrapper });
      await act(async () => {
        expect(await result.current([2, 1])).toBe(false);
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tracks"] });
      expect(useUiStore.getState().undoNotice?.message).toBe("Couldn’t save the new order");
    }
  });

  it("a playlist: the same, where a thrown request used to skip the re-read", async () => {
    for (const answer of [failed, offline]) {
      const { invalidate, wrapper } = setup();
      clientApi.api.PUT.mockImplementation(answer);
      const { result } = renderHook(() => useReorderPlaylist(), { wrapper });
      await act(async () => {
        await result.current(4, [2, 1]);
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["playlist", 4] });
      expect(useUiStore.getState().undoNotice?.message).toBe("Couldn’t save the new order");
    }
  });

  it("an album: the album is re-read, where a failure used to leave the new order on screen", async () => {
    for (const answer of [failed, offline]) {
      const { invalidate, wrapper } = setup();
      clientApi.api.POST.mockImplementation(answer);
      const { result } = renderHook(() => useReorderTracks(), { wrapper });
      await act(async () => {
        expect(await result.current([2, 1])).toBe(false);
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["album"] });
      expect(useUiStore.getState().undoNotice?.message).toBe("Couldn’t save the new order");
    }
  });

  it("a reorder that saves says nothing of the kind", async () => {
    const { wrapper } = setup();
    clientApi.api.POST.mockResolvedValue({ response: new Response(null, { status: 200 }) });
    const { result } = renderHook(() => useReorderFavorites(), { wrapper });
    await act(async () => {
      expect(await result.current([2, 1])).toBe(true);
    });
    expect(useUiStore.getState().undoNotice).toBeNull();
  });
});

describe("a rename", () => {
  it("reaches the copy of the song the player holds", async () => {
    usePlayerStore.setState({ queue: [track(1), track(2)], order: [0, 1], orderPos: 1 });
    const renamed = { ...track(2), title: "A Better Name", artist: "Someone Else" };
    clientApi.api.PATCH.mockResolvedValue({
      data: renamed,
      response: new Response(null, { status: 200 }),
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePatchTrack(), { wrapper });
    await act(async () => {
      expect(await result.current(2, { title: "A Better Name" })).toBe(true);
    });
    const { queue } = usePlayerStore.getState();
    expect(queue[1].title).toBe("A Better Name");
    expect(queue[1].artist).toBe("Someone Else");
    expect(queue[0].title).toBe("Track 1"); // the other row is untouched
  });
});
