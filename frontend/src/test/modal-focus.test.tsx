/* Modal focus regression (§3.4): the review found every aria-modal surface
   leaving focus outside on open, Tab escaping to live background content,
   and focus stranded on close. These tests pin the fix on Now Playing: the
   takeover takes focus on open, Tab cycles within it, and closing restores
   focus to whatever opened it. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Track } from "../api/types";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { NowPlaying } from "../components/NowPlaying";

/* react-virtual needs a ResizeObserver; jsdom has none. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

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

Element.prototype.scrollTo ??= (() => {}) as typeof Element.prototype.scrollTo;

/* jsdom lays nothing out, so every element reports zero rects; the focus
   trap's visibility filter must see them to cycle focus. jsdom defines
   getClientRects (returning empty), so this overrides deliberately. */
Element.prototype.getClientRects = function () {
  return [{}] as unknown as DOMRectList;
} as typeof Element.prototype.getClientRects;

const track = (id: number, title: string): Track => ({
  id,
  title,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: 1,
  disc_no: null,
  year: 2026,
  duration: 180,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: `Artist/Album/${title}.mp3`,
});

beforeEach(() => {
  localStorage.clear();
  usePlayerStore.setState({
    queue: [track(1, "One"), track(2, "Two")],
    order: [0, 1],
    orderPos: 0,
    isPlaying: false,
    position: 12,
    duration: 180,
    buffered: 0,
    volume: 0.8,
    shuffle: false,
    repeat: "off",
  });
  useUiStore.setState({
    getInfoTrackId: null,
    nowPlayingOpen: false,
    organizeOpen: false,
    trackMenu: null,
    contextMenuOpen: false,
    pickerOpen: false,
    queueDragOpen: false,
    undoNotice: null,
  });
});

afterEach(cleanup);

describe("Now Playing modal focus (§3.4)", () => {
  it("moves focus into the takeover on open", () => {
    useUiStore.setState({ nowPlayingOpen: true });
    const { container } = render(<NowPlaying />);
    const surface = container.querySelector(".nowplaying") as HTMLElement;
    expect(surface.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab cycling inside the takeover", () => {
    useUiStore.setState({ nowPlayingOpen: true });
    render(<NowPlaying />);
    const surface = document.querySelector(".nowplaying") as HTMLElement;
    const inside = () =>
      surface.contains(document.activeElement as HTMLElement | null);

    // Open landed focus on the surface's first control (the close button).
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close Now Playing" }),
    );

    for (let i = 0; i < 12; i++) {
      fireEvent.keyDown(surface, { key: "Tab" });
      expect(inside()).toBe(true);
    }
    // Shift+Tab wraps backwards too, still inside.
    for (let i = 0; i < 12; i++) {
      fireEvent.keyDown(surface, { key: "Tab", shiftKey: true });
      expect(inside()).toBe(true);
    }
  });

  it("restores focus to the opener on close", () => {
    useUiStore.setState({ nowPlayingOpen: true });
    render(
      <>
        <button type="button">Opener</button>
        <NowPlaying />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});
