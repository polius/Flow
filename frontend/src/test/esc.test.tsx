/* Esc always closes the topmost surface; only text mid-edit defers it. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Track } from "../api/types";
import {
  isInteractiveControl,
  isTextEditingTarget,
} from "../lib/shortcuts";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { GetInfoPanel } from "../components/GetInfoPanel";
import { NowPlaying } from "../components/NowPlaying";
import { OrganizeSheet } from "../components/OrganizeSheet";

/* react-virtual needs a ResizeObserver; jsdom has none. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

/* jsdom has no matchMedia; the surfaces under test use it for layouts. */
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

/* …nor smooth scrolling on elements. */
Element.prototype.scrollTo ??= (() => {}) as typeof Element.prototype.scrollTo;

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

describe("Esc guard predicates", () => {
  it("treats text fields — and only text fields — as text editing", () => {
    const input = document.createElement("input");
    input.type = "text";
    expect(isTextEditingTarget(input)).toBe(true);
    expect(isInteractiveControl(input)).toBe(true);

    const range = document.createElement("input");
    range.type = "range";
    expect(isTextEditingTarget(range)).toBe(false);
    expect(isInteractiveControl(range)).toBe(true);

    const button = document.createElement("button");
    expect(isTextEditingTarget(button)).toBe(false);
    expect(isInteractiveControl(button)).toBe(true);

    const anchor = document.createElement("a");
    expect(isTextEditingTarget(anchor)).toBe(false);
    expect(isInteractiveControl(anchor)).toBe(true);
  });
});

describe("Esc closes the frontmost surface while a button has focus", () => {
  it("closes the Now Playing takeover", () => {
    useUiStore.setState({ nowPlayingOpen: true });
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <NowPlaying />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Click a control — the last-clicked button keeps focus in real use.
    const shuffle = screen.getByRole("button", { name: "Shuffle" });
    shuffle.focus();
    expect(document.activeElement).toBe(shuffle);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
  });

  it("closes the Organize sheet", () => {
    useUiStore.setState({ organizeOpen: true });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <OrganizeSheet />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const done = screen.getByRole("button", { name: /done/i });
    done.focus();
    expect(document.activeElement).toBe(done);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().organizeOpen).toBe(false);
  });
});

describe("Esc defers only while text is mid-edit", () => {
  it("keeps Get Info open while a field has focus, closes once blurred", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed the cache so the panel's fields render without a server.
    client.setQueryData(["tracks", "one", 1], track(1, "One"));
    useUiStore.setState({ getInfoTrackId: 1 });
    render(
      <QueryClientProvider client={client}>
        <GetInfoPanel />
      </QueryClientProvider>,
    );

    const title = screen.getByLabelText("Title");
    title.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().getInfoTrackId).toBe(1); // the edit survives

    title.blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().getInfoTrackId).toBeNull();
  });
});
