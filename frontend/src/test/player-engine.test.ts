/* The audio engine's failure and control paths, driven through the real
   element listeners: a network blip holds the playhead instead of skipping
   five tracks, a refused stream asks the server about the session before
   skipping, the lock screen's play key loads a restored track, stale async
   plays are dropped, the sleep timer stops, and volume persists. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "../api/types";

const queueApi = vi.hoisted(() => ({
  fetchServerQueue: vi.fn(),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
}));
vi.mock("../api/queue", () => queueApi);

const clientApi = vi.hoisted(() => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), use: vi.fn() },
}));
vi.mock("../api/client", () => clientApi);

const track = (id: number): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: 1,
  disc_no: 1,
  year: 2026,
  duration: 200,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: `track-${id}.mp3`,
  gain_db: null,
  played_at: null,
});

let elements: HTMLAudioElement[] = [];
let handlers: Record<string, (details: MediaSessionActionDetails) => void> = {};

beforeEach(() => {
  localStorage.clear();
  queueApi.fetchServerQueue.mockResolvedValue({ status: "empty" });
  clientApi.api.GET.mockReset();
  elements = [];
  handlers = {};
  const RealAudio = window.Audio;
  vi.stubGlobal(
    "Audio",
    function () {
      const el = new RealAudio();
      el.play = vi.fn(() => Promise.resolve());
      el.pause = vi.fn();
      el.load = vi.fn();
      elements.push(el);
      return el;
    },
  );
  vi.stubGlobal("MediaMetadata", class {
    constructor(public init: unknown) {}
  });
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      metadata: null,
      playbackState: "none",
      setActionHandler: (action: string, fn: (d: MediaSessionActionDetails) => void) => {
        handlers[action] = fn;
      },
      setPositionState: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "mediaSession");
  vi.resetModules();
});

async function importPlayer() {
  vi.resetModules();
  const mod = await import("../stores/player");
  const ui = await import("../stores/ui");
  await new Promise((r) => setTimeout(r, 0));
  return { ...mod, useUiStore: ui.useUiStore };
}

function fail(el: HTMLAudioElement, code: number) {
  Object.defineProperty(el, "error", {
    configurable: true,
    get: () => ({ code, message: "" }),
  });
  el.dispatchEvent(new Event("error"));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("stream failures", () => {
  it("a network error holds the playhead and resumes when back online", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    usePlayerStore.getState().playTracks([1, 2, 3].map(track), 0);
    usePlayerStore.setState({ position: 42 });
    const [audio] = elements;
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    fail(audio, 2); // MEDIA_ERR_NETWORK

    // No skip: still on track 1, paused, the position kept.
    let s = usePlayerStore.getState();
    expect(s.queue[s.order[s.orderPos]].id).toBe(1);
    expect(s.isPlaying).toBe(false);

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    window.dispatchEvent(new Event("online"));

    s = usePlayerStore.getState();
    expect(audio.src).toContain("/api/stream/1");
    expect(audio.currentTime).toBe(42);
    expect(audio.play).toHaveBeenCalledTimes(2); // the start, then the resume
  });

  it("a refused stream with an expired session routes to sign-in, no skip", async () => {
    const { usePlayerStore } = await importPlayer();
    const { queryClient } = await import("../api/queryClient");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clientApi.api.GET.mockResolvedValue({
      data: { enabled: true, authenticated: false },
      response: new Response(null, { status: 200 }),
    });
    usePlayerStore.getState().playTracks([1, 2].map(track), 0);

    fail(elements[0], 4);
    await flush();

    const s = usePlayerStore.getState();
    expect(s.queue[s.order[s.orderPos]].id).toBe(1);
    expect(queryClient.getQueryData(["auth", "status"])).toEqual({
      enabled: true,
      authenticated: false,
    });
  });

  it("a refused stream with a live session skips, and says so", async () => {
    const { usePlayerStore, useUiStore } = await importPlayer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clientApi.api.GET.mockResolvedValue({
      data: { enabled: false, authenticated: false },
      response: new Response(null, { status: 200 }),
    });
    usePlayerStore.getState().playTracks([1, 2].map(track), 0);

    fail(elements[0], 4);
    await flush();

    const s = usePlayerStore.getState();
    expect(s.queue[s.order[s.orderPos]].id).toBe(2);
    expect(useUiStore.getState().undoNotice?.message).toContain("Skipped");
  });
});

describe("media session", () => {
  it("the hardware play key loads a restored track at its saved position", async () => {
    const { usePlayerStore } = await importPlayer();
    // A restored session: populated store, virgin element.
    usePlayerStore.setState({ queue: [track(1)], order: [0], orderPos: 0, position: 30 });
    handlers.play({ action: "play" });
    expect(elements[0].src).toContain("/api/stream/1");
    expect(elements[0].currentTime).toBe(30);
    expect(elements[0].play).toHaveBeenCalled();
  });

  it("registers seek handlers and publishes position state", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1)], 0);
    handlers.seekto({ action: "seekto", seekTime: 50 });
    expect(usePlayerStore.getState().position).toBe(50);
    handlers.seekforward({ action: "seekforward" });
    expect(usePlayerStore.getState().position).toBe(60);
    handlers.seekbackward({ action: "seekbackward", seekOffset: 30 });
    expect(usePlayerStore.getState().position).toBe(30);
    expect(navigator.mediaSession.setPositionState).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 200, position: 30 }),
    );
  });

  it("clearing the queue clears the lock screen and the title", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1)], 0);
    expect(document.title).toContain("Track 1");
    usePlayerStore.getState().clearQueue();
    expect(navigator.mediaSession.metadata).toBeNull();
    expect(document.title).toBe("Flow");
  });
});

describe("async plays", () => {
  it("a request overtaken by a newer play is stale", async () => {
    const { usePlayerStore, beginPlayRequest } = await importPlayer();
    const isCurrent = beginPlayRequest();
    expect(isCurrent()).toBe(true);
    usePlayerStore.getState().playTracks([track(1)], 0); // the user played an album
    expect(isCurrent()).toBe(false);
  });
});

describe("sleep timer", () => {
  it("pauses when the minutes run out, and can be cancelled", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    usePlayerStore.getState().playTracks([track(1)], 0);
    const audio = elements[0];

    usePlayerStore.getState().setSleepTimer(15);
    usePlayerStore.getState().setSleepTimer(null);
    vi.advanceTimersByTime(16 * 60_000);
    expect(audio.pause).not.toHaveBeenCalled();

    usePlayerStore.getState().setSleepTimer(15);
    expect(usePlayerStore.getState().sleep).toMatchObject({ kind: "minutes", minutes: 15 });
    vi.advanceTimersByTime(15 * 60_000);
    expect(audio.pause).toHaveBeenCalled();
    expect(usePlayerStore.getState().sleep).toBeNull();
  });

  it("end of track stops at the boundary, resting on the next track", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([1, 2].map(track), 0);
    usePlayerStore.getState().setSleepTimer("track");
    const audio = elements[0];
    const plays = (audio.play as ReturnType<typeof vi.fn>).mock.calls.length;

    audio.dispatchEvent(new Event("ended"));

    const s = usePlayerStore.getState();
    expect(s.queue[s.order[s.orderPos]].id).toBe(2);
    expect(s.isPlaying).toBe(false);
    expect(s.sleep).toBeNull();
    expect((audio.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(plays);
  });
});

describe("volume", () => {
  it("applies to the element without a graph and persists across loads", async () => {
    let { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1)], 0);
    usePlayerStore.getState().setVolume(0.5);
    expect(elements[0].volume).toBeCloseTo(0.25); // perceptual curve
    usePlayerStore.getState().toggleMute();
    expect(elements[0].volume).toBe(0);

    ({ usePlayerStore } = await importPlayer());
    expect(usePlayerStore.getState().volume).toBe(0.5);
    expect(usePlayerStore.getState().muted).toBe(true);
  });

  it("survives unusable storage", async () => {
    localStorage.setItem("flow.player.volume", "{broken");
    const { usePlayerStore } = await importPlayer();
    expect(usePlayerStore.getState().volume).toBe(1);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => usePlayerStore.getState().setVolume(2)).not.toThrow();
    expect(usePlayerStore.getState().volume).toBe(1);
  });
});
