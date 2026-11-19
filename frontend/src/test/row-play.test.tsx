/* What starts a song from a row: with a mouse, a plain click on the
   title or a double-click anywhere on the row; on touch, a tap anywhere
   on the row. A plain mouse click on the row body only moves the keyboard
   cursor there. Modifier clicks, the long-press menu and the click a
   swipe leaves behind never play. */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn().mockResolvedValue({ status: "empty" }),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
  playByFilter: vi.fn(),
}));

import type { Track } from "../api/types";
import { TrackTable } from "../components/TrackTable";
import { usePlayerStore } from "../stores/player";
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
Element.prototype.scrollIntoView ??= () => {};

const track = (id: number, title: string): Track => ({
  id,
  title,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: id,
  disc_no: 1,
  year: 2026,
  duration: 180,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: `Artist/Album/${title}.mp3`,
  gain_db: null,
  played_at: null,
});

const TRACKS = [track(1, "One"), track(2, "Two"), track(3, "Three")];

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const playTracks = vi.fn();
const togglePlay = vi.fn();

const row = (title: string) => screen.getByText(title).closest<HTMLElement>('[role="row"]')!;
const cell = (title: string, cls: string) => row(title).querySelector<HTMLElement>(cls)!;
/** A real double-click: two clicks (detail 1, then 2) and the dblclick. */
const doubleClick = (el: HTMLElement) => {
  fireEvent.click(el, { detail: 1 });
  fireEvent.click(el, { detail: 2 });
  fireEvent.doubleClick(el, { detail: 2 });
};
const tap = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { pointerType: "touch" });
  fireEvent.click(el, { detail: 1 });
};

beforeEach(() => {
  playTracks.mockReset();
  togglePlay.mockReset();
  usePlayerStore.setState({ queue: [], order: [], orderPos: 0, isPlaying: false, playTracks, togglePlay });
  useUiStore.setState({ trackMenu: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("what plays a row", () => {
  it("a mouse click on the title plays it", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    fireEvent.click(screen.getByText("Two"), { detail: 1 });
    expect(playTracks).toHaveBeenCalledTimes(1);
    expect(playTracks.mock.calls[0][1]).toBe(1);
  });

  it("a mouse click on the row body does not play: it moves the keyboard cursor and selects nothing", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    fireEvent.click(cell("Two", ".trackrow__time"), { detail: 1 });
    expect(playTracks).not.toHaveBeenCalled();
    expect(row("Two")).toHaveClass("trackrow--cursor");
    expect(row("Two")).not.toHaveAttribute("aria-selected");
    // Enter then plays the row that was clicked.
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" });
    expect(playTracks.mock.calls[0][1]).toBe(1);
  });

  it("a double-click on the row body plays it", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    doubleClick(cell("Three", ".trackrow__secondary"));
    expect(playTracks).toHaveBeenCalledTimes(1);
    expect(playTracks.mock.calls[0][1]).toBe(2);
  });

  it("a double-click on the title plays once and does not pause again", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    doubleClick(screen.getByText("Two"));
    expect(playTracks).toHaveBeenCalledTimes(1);
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it("a double-click on the current row resumes it when paused and leaves it alone when playing", () => {
    usePlayerStore.setState({ queue: TRACKS, order: [0, 1, 2], orderPos: 1, isPlaying: false });
    render(wrap(<TrackTable tracks={TRACKS} />));
    doubleClick(cell("Two", ".trackrow__time"));
    expect(togglePlay).toHaveBeenCalledTimes(1);
    act(() => usePlayerStore.setState({ isPlaying: true }));
    doubleClick(cell("Two", ".trackrow__time"));
    expect(togglePlay).toHaveBeenCalledTimes(1);
    expect(playTracks).not.toHaveBeenCalled();
  });

  it("a tap anywhere on the row plays it", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    tap(cell("Three", ".trackrow__duration"));
    expect(playTracks).toHaveBeenCalledTimes(1);
    expect(playTracks.mock.calls[0][1]).toBe(2);
  });

  it("a tap on the heart or a link keeps its own action", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    tap(row("Two").querySelector<HTMLElement>(".trackrow__secondary a")!);
    tap(row("Two").querySelector<HTMLElement>(".trackrow__heartbtn")!);
    expect(playTracks).not.toHaveBeenCalled();
  });

  it("Cmd-click and Shift-click select and never play, with mouse or touch", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    fireEvent.click(cell("One", ".trackrow__time"), { metaKey: true });
    expect(row("One")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByText("Three"), { shiftKey: true });
    expect(row("Two")).toHaveAttribute("aria-selected", "true");
    expect(row("Three")).toHaveAttribute("aria-selected", "true");
    doubleClick(cell("Two", ".trackrow__time"));
    expect(playTracks).toHaveBeenCalledTimes(1); // the plain double-click, not the modifier clicks
  });

  it("a long-press opens the row menu and its click does not play", () => {
    vi.useFakeTimers();
    render(wrap(<TrackTable tracks={TRACKS} />));
    const target = cell("Two", ".trackrow__duration");
    fireEvent.pointerDown(target, { pointerType: "touch" });
    fireEvent.touchStart(target, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.touchEnd(target);
    fireEvent.click(target, { detail: 1 });
    expect(useUiStore.getState().trackMenu?.track.id).toBe(2);
    expect(playTracks).not.toHaveBeenCalled();
  });

  it("the click a swipe leaves behind does not play", () => {
    render(wrap(<TrackTable tracks={TRACKS} variant="playlist" onRemoveTrack={() => {}} />));
    const target = cell("Two", ".trackrow__duration");
    fireEvent.pointerDown(target, { pointerType: "touch" });
    fireEvent.touchStart(target, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchMove(target, { touches: [{ clientX: 120, clientY: 12 }] });
    fireEvent.touchEnd(target);
    fireEvent.click(target, { detail: 1 });
    expect(playTracks).not.toHaveBeenCalled();
  });
});
