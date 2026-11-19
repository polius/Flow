/* Cover cards on touch: no buttons on the cover; a long press on it opens
   the card's menu as a bottom sheet, and the click the hold leaves behind
   does not follow the link. A short tap is still the link's. */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn().mockResolvedValue({ status: "empty" }),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
  playByFilter: vi.fn(),
}));

import { AlbumCard } from "../components/AlbumCard";
import type { components } from "../api/schema";

const album = {
  id: 7,
  title: "Glacier",
  artist: "Aurora Fields",
  artist_id: 1,
  year: 2020,
  track_count: 7,
  artwork_id: null,
  cover_artwork_id: null,
} as components["schemas"]["AlbumSummary"];

/** jsdom has no media queries: answer "touch" or "mouse" for (hover: none). */
const setTouch = (touch: boolean) => {
  window.matchMedia = (query: string) =>
    ({
      matches: touch && query === "(hover: none)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList;
};

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AlbumCard album={album} />
        <Path />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // the album never resolves here
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cover card on touch", () => {
  it("a long press on the cover opens the menu as a sheet, and its click does not follow the link", () => {
    setTouch(true);
    mount();
    const cover = screen.getAllByRole("link", { name: "Glacier" })[0]; // the art; the title is the second
    fireEvent.touchStart(cover, { touches: [{ clientX: 50, clientY: 50 }] });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const sheet = screen.getByRole("menu", { name: "Actions for Glacier" });
    expect(sheet).toHaveClass("tracksheet");
    expect(within(sheet).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Play",
      "Shuffle",
      "Play Next",
      "Add to Queue",
      "Add to Playlist",
    ]);
    fireEvent.touchEnd(cover);
    fireEvent.click(cover);
    expect(screen.getByTestId("path").textContent).toBe("/");
    // The swallow is spent: the next tap is an ordinary one and opens the album.
    fireEvent.click(cover);
    expect(screen.getByTestId("path").textContent).toBe("/albums/7");
  });

  it("a short tap or a scroll does not open the menu", () => {
    setTouch(true);
    mount();
    const cover = screen.getAllByRole("link", { name: "Glacier" })[0]; // the art; the title is the second
    fireEvent.touchStart(cover, { touches: [{ clientX: 50, clientY: 50 }] });
    fireEvent.touchEnd(cover);
    fireEvent.touchStart(cover, { touches: [{ clientX: 50, clientY: 50 }] });
    fireEvent.touchMove(cover, { touches: [{ clientX: 50, clientY: 90 }] });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("with a mouse the menu stays the popover on the “…” button", () => {
    setTouch(false);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Glacier" }));
    expect(screen.getByRole("menu", { name: "Actions for Glacier" })).toHaveClass("album-card__menu");
  });
});
