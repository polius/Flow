/* Marquee selection on the listening tables: modifier clicks build the
   selection — Cmd/Ctrl/Alt toggles, Shift ranges from the anchor, and a
   fresh selection counts the playing track as already in — while plain
   clicks never select (they dissolve a live one). Esc clears unless a
   surface owns the keyboard, and selection is id-keyed so a reorder
   under a live selection moves with the rows. */

import { act, fireEvent, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Track } from "../api/types";
import { useTrackSelection } from "../lib/selection";
import { useUiStore } from "../stores/ui";

const track = (id: number): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: id,
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

const tracks = [1, 2, 3, 4, 5].map(track);

type Selection = ReturnType<typeof useTrackSelection>;

const click = (
  result: { current: Selection },
  index: number,
  init: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => {
  let consumed: boolean | undefined;
  act(() => {
    consumed = result.current.onRowClick(tracks[index], index, {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    });
  });
  return consumed;
};

const pressEscape = () =>
  act(() => {
    fireEvent(window, new KeyboardEvent("keydown", { key: "Escape" }));
  });

beforeEach(() => {
  useUiStore.setState({
    undoNotice: null,
    nowPlayingOpen: false,
    organizeOpen: false,
    pickerOpen: false,
    contextMenuOpen: false,
    getInfoTrackId: null,
  });
});

describe("marquee selection", () => {
  it("Cmd-click toggles one row and consumes the click (the row must not play)", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    expect(click(result, 2, { metaKey: true })).toBe(true);
    expect(result.current.count).toBe(1);
    expect(click(result, 2, { metaKey: true })).toBe(true);
    expect(result.current.count).toBe(0);
  });

  it("Alt-click toggles one row too", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    expect(click(result, 1, { altKey: true })).toBe(true);
    expect(result.current.count).toBe(1);
    expect(click(result, 3, { altKey: true })).toBe(true);
    expect(result.current.count).toBe(2);
    expect(click(result, 1, { altKey: true })).toBe(true);
    expect(result.current.count).toBe(1);
  });

  it("a plain click dissolves a live selection and never selects", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    click(result, 0, { metaKey: true });
    click(result, 1, { metaKey: true });
    expect(result.current.count).toBe(2);
    expect(click(result, 3)).toBe(true);
    expect(result.current.count).toBe(0);
    // With nothing live, a plain click stays nothing.
    expect(click(result, 3)).toBe(true);
    expect(result.current.count).toBe(0);
  });

  it("Shift-click selects the contiguous range from the anchor", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    click(result, 1, { metaKey: true });
    click(result, 3, { shiftKey: true });
    expect([...result.current.ids].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    // The clicked row is the last-selected one — the row Enter plays.
    expect(result.current.lastIndex()).toBe(3);
  });

  it("a fresh modifier selection counts the playing track as already in", () => {
    const { result } = renderHook(() => useTrackSelection(tracks, tracks[2].id));
    click(result, 0, { metaKey: true });
    expect(result.current.count).toBe(2);
    expect([...result.current.ids].sort((a, b) => a - b)).toEqual([1, 3]);
    expect(result.current.selectedTracks.map((t) => t.id)).toEqual([1, 3]);
  });

  it("clicking the playing track itself selects it alone", () => {
    const { result } = renderHook(() => useTrackSelection(tracks, tracks[2].id));
    click(result, 2, { altKey: true });
    expect(result.current.count).toBe(1);
    expect([...result.current.ids]).toEqual([3]);
    // …and a second modifier click on it toggles it back out.
    click(result, 2, { altKey: true });
    expect(result.current.count).toBe(0);
  });

  it("Esc clears the selection, but defers while a surface owns the keyboard", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    click(result, 0, { metaKey: true });
    click(result, 1, { metaKey: true });
    expect(result.current.count).toBe(2);

    act(() => {
      useUiStore.setState({ nowPlayingOpen: true });
    });
    pressEscape();
    expect(result.current.count).toBe(2); // the takeover is topmost

    act(() => {
      useUiStore.setState({ nowPlayingOpen: false });
    });
    pressEscape();
    expect(result.current.count).toBe(0);
  });

  it("selection follows the rows across a reorder (id-keyed, not index-keyed)", () => {
    const { result, rerender } = renderHook(
      (props: { tracks: Track[] }) => useTrackSelection(props.tracks),
      { initialProps: { tracks } },
    );
    click(result, 0, { metaKey: true });
    click(result, 1, { metaKey: true });

    // The playlist reorder: rows 0 and 1 move to the end.
    const reordered = [tracks[2], tracks[3], tracks[4], tracks[0], tracks[1]];
    rerender({ tracks: reordered });

    expect(result.current.selectedTracks.map((t) => t.id)).toEqual([1, 2]);
  });
});
