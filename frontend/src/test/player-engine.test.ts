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

/* The lock screen's failure modes (seen on iOS): an element that behaves
   like the real one — play/pause flip `paused` and fire their events —
   while the clock stays wherever the test leaves it. */
describe("background playback", () => {
  let visibility: DocumentVisibilityState = "visible";

  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  function realisticElement(el: HTMLAudioElement) {
    let paused = true;
    Object.defineProperty(el, "paused", { configurable: true, get: () => paused });
    el.play = vi.fn(() => {
      paused = false;
      el.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    el.pause = vi.fn(() => {
      if (paused) return;
      paused = true;
      el.dispatchEvent(new Event("pause"));
    });
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
    const srcSets: string[] = [];
    Object.defineProperty(el, "src", {
      configurable: true,
      get(this: HTMLMediaElement): string {
        return srcDesc.get!.call(this) as string;
      },
      set(this: HTMLMediaElement, v: string) {
        srcSets.push(v);
        srcDesc.set!.call(this, v);
      },
    });
    return srcSets;
  }

  function returnToForeground() {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("a stream dropped while paused holds quietly: no reload, no notice", async () => {
    const { usePlayerStore, useUiStore } = await importPlayer();
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [audio] = elements;
    const srcSets = realisticElement(audio);
    usePlayerStore.getState().playTracks([1, 2].map(track), 0);
    handlers.pause({ action: "pause" }); // the lock screen's Pause
    usePlayerStore.setState({ position: 42 });
    visibility = "hidden";
    const loads = srcSets.length;

    fail(audio, 1); // iOS aborted the paused stream in the background
    vi.advanceTimersByTime(30_000);
    window.dispatchEvent(new Event("online"));

    expect(srcSets.length).toBe(loads); // never re-pointed in the background
    expect(useUiStore.getState().undoNotice).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    // The lock screen's Play reloads at the playhead and plays.
    handlers.play({ action: "play" });
    expect(srcSets.length).toBe(loads + 1);
    expect(audio.currentTime).toBe(42);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("returning to the foreground re-primes a quiet hold, still paused", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [audio] = elements;
    const srcSets = realisticElement(audio);
    usePlayerStore.getState().playTracks([track(1)], 0);
    handlers.pause({ action: "pause" });
    usePlayerStore.setState({ position: 42 });
    visibility = "hidden";
    fail(audio, 2);
    const loads = srcSets.length;

    returnToForeground();

    expect(srcSets.length).toBe(loads + 1);
    expect(audio.currentTime).toBe(42);
    expect(audio.play).toHaveBeenCalledTimes(1); // the original start only
    expect(navigator.mediaSession.playbackState).toBe("paused");
  });

  it("a frozen play is un-stuck with pause/play on return to the foreground", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.useFakeTimers();
    const [audio] = elements;
    realisticElement(audio);
    usePlayerStore.getState().playTracks([track(1)], 0);
    handlers.pause({ action: "pause" });
    visibility = "hidden";

    // The lock screen's Play: the element flips to playing, the clock
    // never moves. Too soon for the background limit to call it.
    handlers.play({ action: "play" });
    vi.advanceTimersByTime(5000);
    expect(audio.pause).toHaveBeenCalledTimes(1);

    returnToForeground();

    // Checked at once: the same pause/play pair the user would tap.
    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.play).toHaveBeenCalledTimes(3);
    expect(audio.paused).toBe(false);

    // Still frozen after the un-stick: rest paused, honestly.
    vi.advanceTimersByTime(4000);
    expect(audio.paused).toBe(true);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(navigator.mediaSession.playbackState).toBe("paused");
  });

  it("a frozen play in the background rests paused, so the lock screen stops lying", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.useFakeTimers();
    const [audio] = elements;
    realisticElement(audio);
    usePlayerStore.getState().playTracks([track(1)], 0);
    handlers.pause({ action: "pause" });
    visibility = "hidden";

    handlers.play({ action: "play" });
    expect(navigator.mediaSession.playbackState).toBe("playing");
    vi.advanceTimersByTime(11_000);

    expect(audio.paused).toBe(true);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(navigator.mediaSession.playbackState).toBe("paused");
    // The next Play is a real second attempt.
    handlers.play({ action: "play" });
    expect(audio.paused).toBe(false);
  });

  /* The sequence an iPhone logged: the lock screen's Play is blocked, the
     background watchdog gives up — and the timers that do it first run as
     the app comes back, a beat before visibilitychange. */
  async function blockedPlayGivenUp() {
    const mod = await importPlayer();
    vi.useFakeTimers();
    const [audio] = elements;
    realisticElement(audio);
    mod.usePlayerStore.getState().playTracks([track(1)], 0);
    handlers.pause({ action: "pause" });
    visibility = "hidden";
    handlers.play({ action: "play" }); // iOS reports playing; the clock never moves
    vi.advanceTimersByTime(11_000);
    expect(audio.paused).toBe(true); // given up, honestly paused
    return { ...mod, audio };
  }

  it("opening Flow soon after a blocked lock-screen Play starts the music", async () => {
    const { usePlayerStore, audio } = await blockedPlayGivenUp();
    vi.advanceTimersByTime(30_000);

    returnToForeground();

    expect(audio.paused).toBe(false);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("opening Flow long after a blocked Play stays paused", async () => {
    const { audio } = await blockedPlayGivenUp();
    vi.advanceTimersByTime(3 * 60_000);

    returnToForeground();

    expect(audio.paused).toBe(true);
  });

  it("a lock-screen Pause after a blocked Play cancels it", async () => {
    const { audio } = await blockedPlayGivenUp();
    handlers.pause({ action: "pause" });

    returnToForeground();

    expect(audio.paused).toBe(true);
  });

  it("a clock that moves is never frozen", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.useFakeTimers();
    const [audio] = elements;
    realisticElement(audio);
    usePlayerStore.getState().playTracks([track(1)], 0);
    for (let t = 1; t <= 20; t++) {
      audio.currentTime = t;
      vi.advanceTimersByTime(1000);
    }
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.paused).toBe(false);
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

describe("clear the queue, then undo", () => {
  it("brings back the duration, so the scrubber and the seek keys work again", async () => {
    const { usePlayerStore, useUiStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    // The element reported the song's length and how much is buffered.
    usePlayerStore.setState({ duration: 200, buffered: 80, position: 42 });

    usePlayerStore.getState().clearQueue();
    expect(usePlayerStore.getState().duration).toBe(0);
    await useUiStore.getState().undoNotice?.undo?.();

    // The element still holds the song: nothing will report its length again.
    const restored = usePlayerStore.getState();
    expect(restored.queue).toHaveLength(2);
    expect(restored.position).toBe(42);
    expect(restored.duration).toBe(200);
    expect(restored.buffered).toBe(80);

    // The → key's seek (shortcuts.ts refuses to seek at zero duration).
    restored.seek(Math.min(restored.duration, restored.position + 10));
    expect(usePlayerStore.getState().position).toBe(52);
  });
});

describe("the session ends", () => {
  it("a session that expired stops the sound and keeps the queue", async () => {
    const { usePlayerStore, endPlayback } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    elements[0].dispatchEvent(new Event("play"));
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    endPlayback({ forget: false });

    expect(elements[0].pause).toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().queue).toHaveLength(2);
  });

  it("signing out also forgets the queue, here and in this browser's storage", async () => {
    const { usePlayerStore, endPlayback } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    await new Promise((r) => setTimeout(r, 500)); // past the debounced local save
    expect(localStorage.getItem("flow.player.queue")).not.toBeNull();

    endPlayback({ forget: true });

    expect(elements[0].pause).toHaveBeenCalled();
    expect(usePlayerStore.getState().queue).toHaveLength(0);
    expect(localStorage.getItem("flow.player.queue")).toBeNull();
    expect(document.title).toBe("Flow");
  });
});

/* The element's clock, driven by hand: jsdom's never moves. */
function clock(el: HTMLAudioElement, duration = 200) {
  let now = 0;
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    get: () => now,
    set: (v: number) => {
      now = v;
    },
  });
  Object.defineProperty(el, "duration", { configurable: true, get: () => duration });
  return {
    /** Play on for `seconds`, a quarter second per tick like the real event. */
    listen(seconds: number) {
      for (let t = 0; t < seconds; t += 0.25) {
        now += 0.25;
        el.dispatchEvent(new Event("timeupdate"));
      }
    },
    seek(to: number) {
      now = to;
      el.dispatchEvent(new Event("timeupdate"));
    },
  };
}

describe("what counts as a play", () => {
  const stamps = () =>
    queueApi.saveServerPlayhead.mock.calls
      .map(([patch]) => (patch as { playedTrackId?: number }).playedTrackId)
      .filter((id) => id != null);

  it("a song is stamped as played after 30 seconds of listening, once", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    const time = clock(elements[0]);
    elements[0].dispatchEvent(new Event("play"));
    // Starting is not playing: the start syncs the playhead with no stamp.
    expect(queueApi.saveServerPlayhead).toHaveBeenCalled();
    expect(stamps()).toEqual([]);

    time.listen(29);
    expect(stamps()).toEqual([]);
    time.listen(2);
    expect(stamps()).toEqual([1]);
    time.listen(60);
    expect(stamps()).toEqual([1]);
  });

  it("skipping through songs stamps none of them, and scrubbing ahead is not listening", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2), track(3)], 0);
    const time = clock(elements[0]);
    elements[0].dispatchEvent(new Event("play"));
    time.listen(5);
    usePlayerStore.getState().next();
    time.seek(0);
    time.listen(5);
    usePlayerStore.getState().next();
    time.seek(0);
    time.listen(10);
    time.seek(150); // dragged to near the end
    time.listen(10);
    expect(stamps()).toEqual([]);
    time.listen(11); // 31 seconds heard of the third song
    expect(stamps()).toEqual([3]);
  });

  it("a short song counts at half its length", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([{ ...track(1), duration: 40 }], 0);
    const time = clock(elements[0], 40);
    elements[0].dispatchEvent(new Event("play"));
    time.listen(19);
    expect(stamps()).toEqual([]);
    time.listen(2);
    expect(stamps()).toEqual([1]);
  });
});

describe("smaller engine behaviour", () => {
  it("the play button knows when the stream is buffering", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1)], 0);
    const [audio] = elements;
    Object.defineProperty(audio, "paused", { configurable: true, get: () => false });
    audio.dispatchEvent(new Event("play"));
    expect(usePlayerStore.getState().buffering).toBe(false);
    audio.dispatchEvent(new Event("waiting"));
    expect(usePlayerStore.getState().buffering).toBe(true);
    audio.dispatchEvent(new Event("playing"));
    expect(usePlayerStore.getState().buffering).toBe(false);
    audio.dispatchEvent(new Event("waiting"));
    audio.dispatchEvent(new Event("pause"));
    expect(usePlayerStore.getState().buffering).toBe(false);
  });

  it("the sleep timer stops on the song's clock when its timeout is late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // the wall clock moves; timeouts do not fire
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1)], 0);
    const time = clock(elements[0]);
    usePlayerStore.getState().setSleepTimer(15);

    vi.setSystemTime(Date.now() + 14 * 60_000);
    time.listen(1);
    expect(usePlayerStore.getState().sleep).not.toBeNull();

    // The laptop slept through the timeout: 16 minutes later, a tick.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    vi.mocked(elements[0].pause).mockClear();
    time.listen(0.25);
    expect(usePlayerStore.getState().sleep).toBeNull();
    expect(elements[0].pause).toHaveBeenCalled();
  });

  it("the last seconds before sleep fade out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const contexts = stubAudioContext();
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1)], 0);
    const time = clock(elements[0]);
    usePlayerStore.getState().setSleepTimer(15);
    const level = () => contexts[0].gains[0].value;

    vi.setSystemTime(Date.now() + 15 * 60_000 - 20_000);
    time.listen(0.25);
    expect(level()).toBe(1);
    vi.setSystemTime(Date.now() + 16_000); // 4 s left of an 8 s fade
    time.listen(0.25);
    expect(level()).toBeCloseTo(0.5, 1);
    vi.setSystemTime(Date.now() + 5_000);
    time.listen(0.25);
    // Asleep — and the level is back for the next play.
    expect(usePlayerStore.getState().sleep).toBeNull();
    expect(level()).toBe(1);
  });

  it("a seek made while the connection is lost is where playback resumes", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    usePlayerStore.setState({ position: 42 });
    const [audio] = elements;
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fail(audio, 2); // MEDIA_ERR_NETWORK: held at 42

    usePlayerStore.getState().seek(120);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await flush();

    expect(audio.currentTime).toBe(120);
    expect(usePlayerStore.getState().position).toBe(120);
  });

  it("a next song that failed to preload is not requested again on every tick", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    const [audio, standby] = elements;
    const time = clock(audio, 200);
    vi.mocked(standby.load).mockClear();
    time.seek(195); // inside the last ten seconds: the next song preloads
    expect(standby.load).toHaveBeenCalledTimes(1);
    expect(standby.src).toContain("/api/stream/2");

    standby.dispatchEvent(new Event("error"));
    vi.mocked(standby.load).mockClear();
    time.listen(3);
    expect(standby.load).not.toHaveBeenCalled();
    expect(standby.getAttribute("src")).toBeNull();
  });

  it("the preferences are not rewritten to storage while a song plays", async () => {
    const { usePlayerStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1)], 0);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const time = clock(elements[0]);
    time.listen(5); // twenty position updates
    const writes = setItem.mock.calls.filter(([key]) => key === "flow.player").length;
    expect(writes).toBeLessThanOrEqual(1);
    usePlayerStore.getState().setShuffle(true); // a real change is still written
    expect(setItem.mock.calls.filter(([key]) => key === "flow.player").length).toBe(writes + 1);
  });

  it("an album plays every song at the album's level; a mix levels each song", async () => {
    const contexts = stubAudioContext();
    const { usePlayerStore } = await importPlayer();
    const quiet = { ...track(1), gain_db: 4 }; // a quiet interlude
    const loud = { ...track(2), gain_db: -6 }; // the single
    const level = () => contexts[0].gains[0].value;

    usePlayerStore.getState().playTracks([quiet, loud], 0, { kind: "album", label: "Album", href: "/albums/1" });
    // The interlude is NOT pulled up: it gets the album's -6 dB.
    expect(level()).toBeCloseTo(Math.pow(10, -6 / 20), 3);

    usePlayerStore.getState().playTracks([quiet, loud], 0, { kind: "playlist", label: "Mix", href: "/playlists/1" });
    expect(level()).toBeCloseTo(Math.pow(10, 4 / 20), 3);
  });
});

/* A Web Audio stand-in: counts contexts and records the gain each
   element's node was last told to reach. */
function stubAudioContext() {
  const contexts: { gains: { value: number }[] }[] = [];
  class FakeContext {
    state = "running";
    currentTime = 0;
    destination = {};
    gains: { value: number }[] = [];
    constructor() {
      contexts.push(this);
    }
    createMediaElementSource() {
      return { connect() {} };
    }
    createGain() {
      const gain = { value: 1 };
      this.gains.push(gain);
      return {
        gain: {
          setTargetAtTime: (value: number) => {
            gain.value = value;
          },
        },
        connect() {},
      };
    }
    resume() {
      return Promise.resolve();
    }
    suspend() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  return contexts;
}

describe("sound check after a reload", () => {
  const loud = (id: number): Track => ({ ...track(id), gain_db: -9 });

  it("Next builds the audio graph, so the first song is normalized", async () => {
    const contexts = stubAudioContext();
    const { usePlayerStore } = await importPlayer();
    // A restored session: populated store, nothing played yet, no graph.
    usePlayerStore.setState({ queue: [track(1), loud(2)], order: [0, 1], orderPos: 0 });
    expect(contexts).toHaveLength(0);

    usePlayerStore.getState().next();

    expect(elements[0].src).toContain("/api/stream/2");
    expect(contexts).toHaveLength(1);
    // -9 dB at full volume: the live element's node, not unity.
    expect(contexts[0].gains[0].value).toBeCloseTo(0.355, 3);
    // A second press does not build a second graph.
    usePlayerStore.getState().next();
    expect(contexts).toHaveLength(1);
  });

  it("Previous builds it too, and so does the hardware Next key", async () => {
    let contexts = stubAudioContext();
    let { usePlayerStore } = await importPlayer();
    usePlayerStore.setState({ queue: [loud(1), track(2)], order: [0, 1], orderPos: 1 });
    usePlayerStore.getState().prev();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].gains[0].value).toBeCloseTo(0.355, 3);

    contexts = stubAudioContext();
    ({ usePlayerStore } = await importPlayer());
    usePlayerStore.setState({ queue: [track(1), loud(2)], order: [0, 1], orderPos: 0 });
    handlers.nexttrack({ action: "nexttrack" });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].gains[0].value).toBeCloseTo(0.355, 3);
  });
});
