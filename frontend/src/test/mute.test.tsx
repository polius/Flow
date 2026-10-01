/* Click-to-mute regression (§3.4): the volume icon was decoration; now it
   toggles mute like every platform player — the slider keeps its level
   underneath, and moving the slider unmutes. */

import { beforeEach, describe, expect, it } from "vitest";

import { usePlayerStore } from "../stores/player";

beforeEach(() => {
  localStorage.clear();
  usePlayerStore.setState({ volume: 0.8, muted: false });
});

describe("mute (§3.4)", () => {
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
