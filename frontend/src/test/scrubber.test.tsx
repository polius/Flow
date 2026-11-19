/* The scrubber seeks when it was moved, and only then: focus passing over
   it (Tab in, Tab out) used to seek twice to where the song already was. */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn().mockResolvedValue({ status: "empty" }),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
  playByFilter: vi.fn(),
}));

import { PlayPauseButton, Scrubber } from "../components/transport";
import { usePlayerStore } from "../stores/player";

const seek = vi.fn<(seconds: number) => void>();

beforeEach(() => {
  seek.mockReset();
  usePlayerStore.setState({ seek, position: 30, duration: 200, buffered: 60, buffering: false });
});

afterEach(cleanup);

describe("scrubber", () => {
  it("does not seek when focus merely passes over it", () => {
    render(<Scrubber />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent.focus(slider);
    fireEvent.keyUp(slider, { key: "Tab" });
    fireEvent.blur(slider);
    expect(seek).not.toHaveBeenCalled();
  });

  it("commits a position the listener chose, once the key or pointer is released", () => {
    render(<Scrubber />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent.input(slider, { target: { value: "90" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(seek).toHaveBeenLastCalledWith(90);
    seek.mockClear();
    // Released: a later blur is not another seek.
    fireEvent.blur(slider);
    expect(seek).not.toHaveBeenCalled();
  });
});

describe("play button", () => {
  it("shows a spinner while a playing stream is buffering, and never while paused", () => {
    const { rerender } = render(<PlayPauseButton isPlaying />);
    expect(document.querySelector(".transport-buffering")).toBeNull();
    usePlayerStore.setState({ buffering: true });
    rerender(<PlayPauseButton isPlaying />);
    expect(document.querySelector(".transport-buffering")).not.toBeNull();
    rerender(<PlayPauseButton isPlaying={false} />);
    expect(document.querySelector(".transport-buffering")).toBeNull();
  });
});
