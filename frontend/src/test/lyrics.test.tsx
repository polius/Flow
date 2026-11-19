/* Lyrics (G1): the line being sung is lit, a tap on a synced line seeks
   there, and plain lyrics are just lines. */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn(() => Promise.resolve({ status: "empty" })),
  claimServerQueue: vi.fn(),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
}));

import { LyricsPanel } from "../components/Lyrics";
import { currentLine } from "../lib/lyrics";
import { usePlayerStore } from "../stores/player";

const synced = {
  synced: true,
  lines: [
    { time: 1, text: "One" },
    { time: 5, text: "Two" },
    { time: 9, text: "Three" },
  ],
};

afterEach(cleanup);
const lit = (text: string) => screen.getByText(text).closest("li")?.getAttribute("aria-current");

describe("lyrics", () => {
  it("knows which line is being sung", () => {
    expect(currentLine(synced.lines, 0)).toBe(-1);
    expect(currentLine(synced.lines, 5)).toBe(1);
    expect(currentLine(synced.lines, 60)).toBe(2);
  });

  it("lights the current line and seeks on a tap", () => {
    const seek = vi.fn();
    usePlayerStore.setState({ position: 6, seek });
    render(<LyricsPanel lyrics={synced} />);
    expect(lit("Two")).toBe("true");
    act(() => void usePlayerStore.setState({ position: 9.5 }));
    expect(lit("Three")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    expect(seek).toHaveBeenCalledWith(1);
  });

  it("shows plain lyrics as lines, with nothing to tap", () => {
    render(<LyricsPanel lyrics={{ synced: false, lines: [{ time: null, text: "Just words" }] }} />);
    expect(screen.getByText("Just words")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
