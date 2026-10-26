/* Smaller data-flow guarantees: the row menu's Play is the row click
   (one whole-view request, not a page-by-page fetch), and a failed
   playlist removal puts the optimistically dropped row back. */

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

import { useRemoveFromPlaylist } from "../api/mutations";
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
