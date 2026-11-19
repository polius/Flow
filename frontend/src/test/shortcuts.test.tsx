/* The player and navigation keys (M S R Q N, Shift+arrows, 0–9, G then a
   letter) work from any view, never while typing or under an open menu
   or dialog, and can be switched off in Settings.

   The global Space shortcut acts once or not at all: a handler closer to
   the focus that already took the key wins, a focused role=button is a
   control, held Space doesn't machine-gun, a button the mouse just
   clicked doesn't own Space (it would press it again), and the track
   table's single Tab stop still means play/pause. */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryRouter, useLocation } from "react-router";

import { isInteractiveControl, useGlobalShortcuts, usePlayerKeys } from "../lib/shortcuts";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

function Harness() {
  useGlobalShortcuts();
  return (
    <>
      <div role="button" tabIndex={0} data-testid="row" onKeyDown={(e) => {
        if (e.key === " ") e.preventDefault(); // the row's own Space
      }} />
      <div role="button" tabIndex={0} data-testid="bare-row" />
      <div role="table" tabIndex={0} data-testid="table" />
      <button type="button" data-testid="next">Next</button>
    </>
  );
}

let toggle: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  toggle = vi.fn<() => void>();
  usePlayerStore.setState({ togglePlay: toggle });
  useUiStore.setState({ pickerOpen: false, contextMenuOpen: false });
});

afterEach(() => {
  cleanup();
});

const space = (target: Element, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: " ", bubbles: true, ...init });

describe("global Space", () => {
  it("does nothing when a closer handler already took the key", () => {
    const { getByTestId } = render(<Harness />);
    const row = getByTestId("row");
    row.focus();
    space(row);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("treats a focused role=button as a control", () => {
    const { getByTestId } = render(<Harness />);
    const row = getByTestId("bare-row");
    row.focus();
    expect(isInteractiveControl(row)).toBe(true);
    space(row);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("toggles once for a held key", () => {
    const { getByTestId } = render(<Harness />);
    const table = getByTestId("table");
    table.focus();
    space(table);
    space(table, { repeat: true });
    space(table, { repeat: true });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("the track table's Tab stop is not a control: Space plays", () => {
    const { getByTestId } = render(<Harness />);
    expect(isInteractiveControl(getByTestId("table"))).toBe(false);
  });

  it("after a mouse click on a button, Space is play/pause, not that button", () => {
    const { getByTestId } = render(<Harness />);
    const next = getByTestId("next");
    fireEvent.pointerDown(next);
    next.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    next.dispatchEvent(event);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true); // the native press is cancelled
  });

  it("a button reached by keyboard keeps its own Space", () => {
    const { getByTestId } = render(<Harness />);
    const next = getByTestId("next");
    fireEvent.pointerDown(next);
    fireEvent.keyDown(window, { key: "Tab" });
    next.focus();
    space(next);
    expect(toggle).not.toHaveBeenCalled();
  });
});

function KeysHarness() {
  usePlayerKeys();
  const location = useLocation();
  return (
    <>
      <span data-testid="path">{location.pathname}</span>
      <input data-testid="field" />
      <input type="range" data-testid="slider" />
      <button type="button" data-testid="button">Button</button>
    </>
  );
}

describe("player and navigation keys", () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
    fireEvent.keyDown(target, { key, bubbles: true, ...init });
  const actions = {
    toggleMute: vi.fn<() => void>(),
    setShuffle: vi.fn<(on: boolean) => void>(),
    cycleRepeat: vi.fn<() => void>(),
    setVolume: vi.fn<(v: number) => void>(),
    seek: vi.fn<(s: number) => void>(),
  };
  const mount = () =>
    render(
      <MemoryRouter initialEntries={["/albums"]}>
        <KeysHarness />
      </MemoryRouter>,
    );

  beforeEach(() => {
    Object.values(actions).forEach((fn) => fn.mockReset());
    usePlayerStore.setState({
      ...actions,
      queue: [{ id: 1 } as never],
      duration: 200,
      shuffle: false,
      volume: 0.5,
      muted: false,
    });
    useUiStore.setState({
      pickerOpen: false,
      contextMenuOpen: false,
      organizeOpen: false,
      getInfoTrackId: null,
      nowPlayingOpen: false,
      queueSheetOpen: false,
      letterKeys: true,
    });
  });

  it("M mutes, S shuffles, R cycles repeat", () => {
    mount();
    press("m");
    press("S"); // caps lock is not a different key
    press("r");
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(actions.setShuffle).toHaveBeenCalledWith(true);
    expect(actions.cycleRepeat).toHaveBeenCalledTimes(1);
  });

  it("Shift+↑ and Shift+↓ change the volume; a focused slider keeps its arrows", () => {
    const { getByTestId } = mount();
    press("ArrowUp", { shiftKey: true });
    expect(actions.setVolume).toHaveBeenLastCalledWith(0.55);
    press("ArrowDown", { shiftKey: true });
    expect(actions.setVolume).toHaveBeenLastCalledWith(0.45);
    const slider = getByTestId("slider");
    slider.focus();
    press("ArrowUp", { shiftKey: true }, slider);
    expect(actions.setVolume).toHaveBeenCalledTimes(2);
  });

  it("0–9 seek to that tenth of the song", () => {
    mount();
    press("3");
    expect(actions.seek).toHaveBeenLastCalledWith(60);
    press("0");
    expect(actions.seek).toHaveBeenLastCalledWith(0);
  });

  it("N opens and closes Now Playing; Q opens it on the queue and closes it", () => {
    mount();
    press("n");
    expect(useUiStore.getState().nowPlayingOpen).toBe(true);
    press("n");
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
    press("q");
    expect(useUiStore.getState()).toMatchObject({ nowPlayingOpen: true, queueSheetOpen: true });
    press("q");
    expect(useUiStore.getState()).toMatchObject({ nowPlayingOpen: false, queueSheetOpen: false });
  });

  it("G then a letter goes to a section, and closes Now Playing on the way", () => {
    const { getByTestId } = mount();
    press("g");
    press("h");
    expect(getByTestId("path").textContent).toBe("/");
    useUiStore.setState({ nowPlayingOpen: true });
    press("g");
    press("s"); // a section here, not shuffle
    expect(getByTestId("path").textContent).toBe("/tracks");
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
    expect(actions.setShuffle).not.toHaveBeenCalled();
    press("g");
    press("p");
    expect(getByTestId("path").textContent).toBe("/playlists");
    // Without the G, the letter keeps its own meaning.
    press("s");
    expect(actions.setShuffle).toHaveBeenCalledTimes(1);
  });

  it("nothing fires while typing, under a menu or dialog, or with a modifier", () => {
    const { getByTestId } = mount();
    const field = getByTestId("field");
    field.focus();
    for (const key of ["m", "s", "r", "q", "n", "5"]) press(key, {}, field);
    press("ArrowUp", { shiftKey: true }, field);
    field.blur();
    useUiStore.setState({ contextMenuOpen: true });
    for (const key of ["m", "s", "r", "q", "n", "5"]) press(key);
    useUiStore.setState({ contextMenuOpen: false, pickerOpen: true });
    for (const key of ["m", "s", "r", "q", "n", "5"]) press(key);
    useUiStore.setState({ pickerOpen: false });
    for (const key of ["m", "s", "r", "q", "n", "5"]) press(key, { metaKey: true });
    Object.values(actions).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
  });

  it("a focused button does not block a letter", () => {
    const { getByTestId } = mount();
    const button = getByTestId("button");
    button.focus();
    press("m", {}, button);
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
  });

  it("the Settings switch turns the single keys off and leaves the volume chord on", () => {
    mount();
    useUiStore.setState({ letterKeys: false });
    for (const key of ["m", "s", "r", "q", "n", "5", "g"]) press(key);
    expect(actions.toggleMute).not.toHaveBeenCalled();
    expect(actions.seek).not.toHaveBeenCalled();
    expect(useUiStore.getState().nowPlayingOpen).toBe(false);
    press("ArrowUp", { shiftKey: true });
    expect(actions.setVolume).toHaveBeenCalledTimes(1);
  });
});
