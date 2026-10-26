/* The track tables are real ARIA grids (audit D9): a contextual label, a
   header row of columnheaders that lines up with every row's gridcells,
   aria-rowindex, and aria-activedescendant following the keyboard cursor.
   Row actions are keyboard-reachable (D8: the "…" button, Shift+F10, the
   ContextMenu key) and reorderable tables move rows with Alt+↑/↓ (D11).
   The top-bar search is a wired combobox (D10). */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

import { api } from "../api/client";
import type { Track } from "../api/types";
import { TopBar } from "../components/TopBar";
import { TrackTable } from "../components/TrackTable";
import { TrackTableHead } from "../components/TrackTableHead";
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

beforeEach(() => {
  useUiStore.setState({ trackMenu: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("track grid semantics", () => {
  it("is a labelled grid whose header cells line up with every row's cells", () => {
    render(
      wrap(
        <TrackTable
          tracks={TRACKS}
          variant="playlist"
          head={<TrackTableHead variant="playlist" />}
          label="Songs in Road Trip"
          onMove={() => {}}
          onRemoveTrack={() => {}}
        />,
      ),
    );
    const grid = screen.getByRole("grid", { name: "Songs in Road Trip" });
    expect(grid).toHaveAttribute("aria-rowcount", "4");

    const headers = within(grid).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "#Number",
      "Title",
      "Artist",
      "Album",
      "Time",
      "Favorite",
      "Remove",
    ]);

    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveAttribute("aria-rowindex", "1");
    rows.slice(1).forEach((row, i) => {
      expect(row).toHaveAttribute("aria-rowindex", String(i + 2));
      expect(within(row).getAllByRole("gridcell")).toHaveLength(headers.length);
    });
    // The play button is reachable: no focusable control hides under aria-hidden.
    expect(within(rows[1]).getByRole("button", { name: "Play One" })).toBeInTheDocument();
  });

  it("aria-activedescendant follows the keyboard cursor", () => {
    render(wrap(<TrackTable tracks={TRACKS} label="Songs" />));
    const grid = screen.getByRole("grid", { name: "Songs" });
    expect(grid).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    const active = grid.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)).toHaveTextContent("Two");
  });
});

describe("keyboard row actions", () => {
  it("the '…' button opens the row menu", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    fireEvent.click(screen.getByRole("button", { name: "More actions for Two" }));
    expect(useUiStore.getState().trackMenu?.track.title).toBe("Two");
  });

  it("Shift+F10 opens the cursor row's menu; ContextMenu on a row control opens that row's", () => {
    render(wrap(<TrackTable tracks={TRACKS} />));
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "F10", shiftKey: true });
    expect(useUiStore.getState().trackMenu?.track.title).toBe("One");

    useUiStore.setState({ trackMenu: null });
    const heart = within(screen.getAllByRole("row")[2]).getByRole("button", {
      name: "Add to Favorites",
    });
    fireEvent.keyDown(heart, { key: "ContextMenu" });
    expect(useUiStore.getState().trackMenu?.track.title).toBe("Three");
  });

  it("Alt+↑/↓ reorders a reorderable table and the cursor travels with the row", () => {
    const onMove = vi.fn();
    render(wrap(<TrackTable tracks={TRACKS} variant="album" onMove={onMove} />));
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown", altKey: true });
    expect(onMove).toHaveBeenCalledWith(0, 1);
    expect(document.getElementById(grid.getAttribute("aria-activedescendant")!)).toHaveAttribute(
      "aria-rowindex",
      "2",
    );
    // Clamped at the top: no move past the first slot.
    fireEvent.keyDown(grid, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(grid, { key: "ArrowUp", altKey: true });
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove).toHaveBeenLastCalledWith(1, 0);
  });

  it("Alt+↑/↓ does nothing on a table that can't reorder", () => {
    const onMove = vi.fn();
    render(wrap(<TrackTable tracks={TRACKS} variant="all" onMove={onMove} />));
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown", altKey: true });
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("search combobox", () => {
  it("wires role, expanded, controls and the active option", async () => {
    const fakeGet = (path: string) =>
      Promise.resolve({
        data:
          path === "/api/search"
            ? { tracks: [TRACKS[0]], albums: [], artists: [], playlists: [] }
            : null,
        response: new Response(null, { status: 200 }),
      });
    vi.spyOn(api, "GET").mockImplementation(fakeGet);
    render(wrap(<TopBar />));
    const input = screen.getByRole("combobox", { name: "Search library" });
    expect(input).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input, { target: { value: "one" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "Search results" });
    expect(input).toHaveAttribute("aria-controls", listbox.id);

    const option = await within(listbox).findByRole("option", { name: /One/ });
    // Nothing highlighted: "See all results" is the active row.
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent(
      "See all results",
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(option).toHaveAttribute("aria-selected", "true");
  });
});
