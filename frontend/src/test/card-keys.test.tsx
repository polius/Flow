/* A grid of cover cards from the keyboard (A1): one Tab stop per card,
   arrows between cards, Shift+F10 or the Menu key opens the card's menu
   with focus inside it, Up/Down walk the items, Esc hands focus back to
   the cover, and Tab out of the menu closes it. */

import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AlbumSummary } from "../api/types";

const clientApi = vi.hoisted(() => ({
  api: {
    GET: vi.fn(() => new Promise(() => {})), // the menu's track list never arrives
    POST: vi.fn(),
    PATCH: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
    use: vi.fn(),
  },
}));
vi.mock("../api/client", () => clientApi);

import { AlbumCard } from "../components/AlbumCard";

const album = (id: number): AlbumSummary => ({
  id,
  title: `Album ${id}`,
  artist: "Artist",
  artist_id: 1,
  year: 2026,
  artwork_id: null,
  track_count: 3,
});

// The cover link (the title below it is a second link, out of the Tab order).
const cover = (id: number) =>
  screen.getAllByRole("link", { name: `Album ${id}` }).find((el) => el.tabIndex === 0)!;

beforeEach(() => {
  // A desktop pointer: the card's menu is the anchored popover.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <div className="covergrid">
          {[1, 2, 3].map((id) => (
            <AlbumCard key={id} album={album(id)} />
          ))}
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
});

describe("album cards from the keyboard", () => {
  it("is one Tab stop per card: the cover", () => {
    const stops = [...document.querySelectorAll<HTMLElement>("a[href], button")].filter(
      (el) => el.tabIndex >= 0,
    );
    expect(stops).toEqual([cover(1), cover(2), cover(3)]);
  });

  it("moves between covers with the arrows", () => {
    cover(1).focus();
    fireEvent.keyDown(cover(1), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cover(2));
    fireEvent.keyDown(cover(2), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cover(1));
    fireEvent.keyDown(cover(1), { key: "ArrowLeft" }); // the first card: nowhere to go
    expect(document.activeElement).toBe(cover(1));
  });

  it("opens the menu on Shift+F10, walks it, and gives focus back on Esc", () => {
    cover(2).focus();
    fireEvent.keyDown(cover(2), { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Actions for Album 2" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Play" }));
    // The list is still loading: Up/Down skip the items it disables.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Shuffle" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Play" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(cover(2));
  });

  it("opens the menu on the Menu key and closes it when focus leaves", () => {
    cover(1).focus();
    fireEvent.keyDown(cover(1), { key: "ContextMenu" });
    const item = screen.getByRole("menuitem", { name: "Play" });
    expect(document.activeElement).toBe(item);
    fireEvent.focusOut(item, { relatedTarget: cover(3) });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
