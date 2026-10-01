/* Marquee selection on the listening tables (UX review 2, §4.1, DESIGN.md
   §36): Cmd/Ctrl-click toggles and consumes the click (the row must not
   play), Shift-click ranges from the anchor, a plain click clears any
   selection and falls through to the row's §23.1 play, Enter's
   last-selected row is exposed, and Esc clears — unless a surface owns the
   keyboard (§16.4). Selection is id-keyed, so a reorder under a live
   selection moves with the rows instead of re-pointing at others. */

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
  init: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {},
) => {
  let consumed: boolean | undefined;
  act(() => {
    consumed = result.current.onRowClick(tracks[index], index, {
      metaKey: false,
      ctrlKey: false,
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

describe("marquee selection (§4.1)", () => {
  it("Cmd-click toggles one row and consumes the click (the row must not play)", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    expect(click(result, 2, { metaKey: true })).toBe(true);
    expect(result.current.count).toBe(1);
    expect(click(result, 2, { metaKey: true })).toBe(true);
    expect(result.current.count).toBe(0);
  });

  it("a plain click clears any selection and falls through to play (§23.1)", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    click(result, 0, { metaKey: true });
    click(result, 1, { metaKey: true });
    expect(result.current.count).toBe(2);
    expect(click(result, 3)).toBe(false);
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

  it("Esc clears the selection, but defers while a surface owns the keyboard", () => {
    const { result } = renderHook(() => useTrackSelection(tracks));
    click(result, 0, { metaKey: true });
    click(result, 1, { metaKey: true });
    expect(result.current.count).toBe(2);

    act(() => {
      useUiStore.setState({ nowPlayingOpen: true });
    });
    pressEscape();
    expect(result.current.count).toBe(2); // the takeover is topmost (§16.4)

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
