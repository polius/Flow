/* Now Playing on touch: a drag down from the cover closes the view, a
   short drag springs back, and a drag that starts on a control (the
   scrubber) is that control's own. */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn().mockResolvedValue({ status: "empty" }),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
  playByFilter: vi.fn(),
}));

import type { Track } from "../api/types";
import { NowPlaying } from "../components/NowPlaying";
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
Element.prototype.scrollTo ??= () => {};

const track = {
  id: 1,
  title: "Altitude",
  artist: "Aurora Fields",
  artist_id: 1,
  album: "Sea of Clouds",
  album_id: 1,
  track_no: 2,
  disc_no: 1,
  year: 2015,
  duration: 200,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: "a.mp3",
  gain_db: null,
  played_at: null,
} as Track;

const drag = (el: Element, fromY: number, toY: number, x = 100) => {
  fireEvent.touchStart(el, { touches: [{ clientX: x, clientY: fromY }] });
  fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: (fromY + toY) / 2 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: toY }] });
  fireEvent.touchEnd(el);
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  usePlayerStore.setState({ queue: [track], order: [0], orderPos: 0, duration: 200 });
  useUiStore.setState({ nowPlayingOpen: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NowPlaying />
      </MemoryRouter>
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = () =>
  act(() => {
    vi.advanceTimersByTime(1000); // a slow drag: distance decides, not the flick
  });

describe("Now Playing swipe to close", () => {
  it("a long drag down from the cover closes the view", () => {
    const cover = document.querySelector(".nowplaying__art")!;
    fireEvent.touchStart(cover, { touches: [{ clientX: 100, clientY: 200 }] });
    settle();
    fireEvent.touchMove(cover, { touches: [{ clientX: 100, clientY: 400 }] });
    fireEvent.touchMove(cover, { touches: [{ clientX: 100, clientY: 520 }] });
    // The view follows the finger.
    expect(screen.getByRole("dialog", { name: "Now Playing" }).style.transform).toBe(
      "translateY(320px)",
    );
    fireEvent.touchEnd(cover);
    settle();
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
  });

  it("a short drag springs back and the view stays", () => {
    const cover = document.querySelector(".nowplaying__art")!;
    fireEvent.touchStart(cover, { touches: [{ clientX: 100, clientY: 200 }] });
    settle();
    fireEvent.touchMove(cover, { touches: [{ clientX: 100, clientY: 280 }] });
    fireEvent.touchEnd(cover);
    settle();
    expect(useUiStore.getState().nowPlayingOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Now Playing" }).style.transform).toBe("");
  });

  it("a quick flick down closes it even when short", () => {
    drag(document.querySelector(".nowplaying__art")!, 200, 330);
    settle();
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
  });

  it("a drag that starts on the scrubber, or runs sideways, is not a close", () => {
    drag(screen.getByRole("slider", { name: "Seek" }), 200, 700);
    settle();
    const cover = document.querySelector(".nowplaying__art")!;
    fireEvent.touchStart(cover, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(cover, { touches: [{ clientX: 300, clientY: 230 }] });
    fireEvent.touchMove(cover, { touches: [{ clientX: 320, clientY: 700 }] });
    fireEvent.touchEnd(cover);
    settle();
    expect(useUiStore.getState().nowPlayingOpen).toBe(true);
  });
});
