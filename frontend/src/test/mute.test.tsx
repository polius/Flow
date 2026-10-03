/* The volume icon toggles mute; the slider keeps its level underneath and
   moving it unmutes. */

import { beforeEach, describe, expect, it } from "vitest";

import { usePlayerStore } from "../stores/player";

beforeEach(() => {
  localStorage.clear();
  usePlayerStore.setState({ volume: 0.8, muted: false });
});

describe("mute", () => {
  it("toggles without losing the slider level", () => {
    const { toggleMute } = usePlayerStore.getState();
    toggleMute();
    expect(usePlayerStore.getState().muted).toBe(true);
    expect(usePlayerStore.getState().volume).toBe(0.8); // level kept
    toggleMute();
    expect(usePlayerStore.getState().muted).toBe(false);
  });

  it("unmutes when the volume rises", () => {
    usePlayerStore.getState().toggleMute();
    usePlayerStore.getState().setVolume(0.5);
    expect(usePlayerStore.getState().muted).toBe(false);
    expect(usePlayerStore.getState().volume).toBe(0.5);
  });
});
