/* The global Space shortcut acts once or not at all: a handler closer to
   the focus that already took the key wins, a focused role=button is a
   control, held Space doesn't machine-gun, a button the mouse just
   clicked doesn't own Space (it would press it again), and the track
   table's single Tab stop still means play/pause. */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isInteractiveControl, useGlobalShortcuts } from "../lib/shortcuts";
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
