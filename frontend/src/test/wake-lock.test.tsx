/* Keep screen on while playing: the lock is held only while the setting
   is on and a song plays, let go on pause, and asked for again when the
   page comes back (the browser drops it whenever the page is hidden). */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useKeepScreenOn } from "../lib/wakeLock";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

interface Sentinel {
  released: boolean;
  release: () => Promise<void>;
}
let held: Sentinel[];
let request: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const live = () => held.filter((s) => !s.released).length;

beforeEach(() => {
  held = [];
  visibility = "visible";
  request = vi.fn(async () => {
    const s: Sentinel = {
      released: false,
      release: async () => {
        s.released = true;
      },
    };
    held.push(s);
    return s;
  });
  Object.defineProperty(navigator, "wakeLock", {
    value: { request },
    configurable: true,
  });
  Object.defineProperty(document, "visibilityState", {
    get: () => visibility,
    configurable: true,
  });
  useUiStore.setState({ keepAwake: false });
  usePlayerStore.setState({ isPlaying: false });
});

afterEach(() => {
  cleanup();
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
});

describe("keep screen on while playing", () => {
  it("is off by default: playing takes no lock", async () => {
    renderHook(() => useKeepScreenOn());
    await act(async () => {
      usePlayerStore.setState({ isPlaying: true });
    });
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it("holds the lock while on and playing, and lets it go on pause", async () => {
    useUiStore.setState({ keepAwake: true });
    renderHook(() => useKeepScreenOn());
    await flush();
    expect(request).not.toHaveBeenCalled(); // nothing playing yet
    await act(async () => {
      usePlayerStore.setState({ isPlaying: true });
    });
    await flush();
    expect(request).toHaveBeenCalledWith("screen");
    expect(live()).toBe(1);
    await act(async () => {
      usePlayerStore.setState({ isPlaying: false });
    });
    await flush();
    expect(live()).toBe(0);
  });

  it("lets it go when the setting is turned off mid-song", async () => {
    useUiStore.setState({ keepAwake: true });
    usePlayerStore.setState({ isPlaying: true });
    renderHook(() => useKeepScreenOn());
    await flush();
    expect(live()).toBe(1);
    await act(async () => {
      useUiStore.setState({ keepAwake: false });
    });
    await flush();
    expect(live()).toBe(0);
  });

  it("asks again when the page comes back, once the browser dropped it", async () => {
    useUiStore.setState({ keepAwake: true });
    usePlayerStore.setState({ isPlaying: true });
    renderHook(() => useKeepScreenOn());
    await flush();
    // Hidden: the browser releases the lock itself.
    visibility = "hidden";
    held[0].released = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(request).toHaveBeenCalledTimes(1); // no request while hidden
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(live()).toBe(1);
  });

  it("does nothing where the browser has no wake lock", async () => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    useUiStore.setState({ keepAwake: true });
    usePlayerStore.setState({ isPlaying: true });
    expect(() => renderHook(() => useKeepScreenOn())).not.toThrow();
    await flush();
    expect(request).not.toHaveBeenCalled();
  });
});
