/* Batch 4 after its independent review: the sleep fade gives the level
   back when the timer changes, a session claim takes the server's own rows
   (hearts right, undo still works), a network blip neither loses nor
   repeats a counted listen, sign-out leaves nothing behind, an undo of a
   clear brings back the song it shows, and a song with no album is
   levelled on its own. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "../api/types";


const queueApi = vi.hoisted(() => ({
  claimServerQueue: vi.fn(),
  fetchServerQueue: vi.fn(),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
}));
vi.mock("../api/queue", () => queueApi);

const clientApi = vi.hoisted(() => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), use: vi.fn() },
}));
vi.mock("../api/client", () => clientApi);

const track = (id: number, extra: Partial<Track> = {}): Track => ({
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
  ...extra,
});

let elements: HTMLAudioElement[] = [];
let handlers: Record<string, (d: unknown) => void> = {};

beforeEach(() => {
  localStorage.clear();
  queueApi.fetchServerQueue.mockReset();
  queueApi.saveServerQueue.mockReset();
  queueApi.saveServerPlayhead.mockReset();
  queueApi.fetchServerQueue.mockResolvedValue({ status: "empty" });
  clientApi.api.GET.mockReset();
  elements = [];
  handlers = {};
  const RealAudio = window.Audio;
  vi.stubGlobal("Audio", function () {
    const el = new RealAudio();
    el.play = vi.fn(() => Promise.resolve());
    el.pause = vi.fn();
    el.load = vi.fn();
    elements.push(el);
    return el;
  });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(public init: unknown) {}
    },
  );
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      metadata: null,
      playbackState: "none",
      setActionHandler: (action: string, fn: (d: unknown) => void) => {
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
  Object.defineProperty(el, "error", { configurable: true, get: () => ({ code, message: "" }) });
  el.dispatchEvent(new Event("error"));
}
const flush = () => new Promise((r) => setTimeout(r, 0));

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
  Object.defineProperty(el, "readyState", { configurable: true, get: () => 4 });
  return {
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

function stubAudioContext() {
  const contexts: { gains: { value: number }[]; state: string }[] = [];
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

const stamps = () =>
  queueApi.saveServerPlayhead.mock.calls
    .map(([patch]) => (patch as { playedTrackId?: number }).playedTrackId)
    .filter((id) => id != null);

describe("sleep fade", () => {
  async function intoTheFade() {
    vi.useFakeTimers({ toFake: ["Date"] });
    const contexts = stubAudioContext();
    const mod = await importPlayer();
    mod.usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    const time = clock(elements[0]);
    mod.usePlayerStore.getState().setSleepTimer(15);
    vi.setSystemTime(Date.now() + 15 * 60_000 - 4_000); // 4 s left of the 8 s fade
    time.listen(0.25);
    const level = (i = 0) => contexts[0].gains[i].value;
    expect(level()).toBeCloseTo(0.5, 1);
    return { ...mod, time, level, contexts };
  }

  it("cancelling the timer during the fade brings the level back", async () => {
    const { usePlayerStore, time, level } = await intoTheFade();
    usePlayerStore.getState().setSleepTimer(null);
    time.listen(5);
    expect(usePlayerStore.getState().sleep).toBeNull();
    expect(level()).toBe(1);
  });

  it("setting a longer timer during the fade brings the level back", async () => {
    const { usePlayerStore, time, level } = await intoTheFade();
    usePlayerStore.getState().setSleepTimer(30);
    time.listen(5);
    expect(level()).toBe(1);
  });

  it("switching to 'end of track' during the fade brings the level back", async () => {
    const { usePlayerStore, time, level } = await intoTheFade();
    usePlayerStore.getState().setSleepTimer("track");
    time.listen(5);
    expect(level()).toBe(1);
  });

  it("a cancelled fade does not carry into the next song through the gapless swap", async () => {
    const { usePlayerStore, time, level } = await intoTheFade();
    // The next song preloads inside the fade (last 10 s of the song).
    const standbyEl = elements[1];
    Object.defineProperty(standbyEl, "readyState", { configurable: true, get: () => 4 });
    time.seek(195);
    expect(standbyEl.src).toContain("/api/stream/2");
    usePlayerStore.getState().setSleepTimer(null);
    elements[0].dispatchEvent(new Event("ended")); // gapless swap to the standby
    const s = usePlayerStore.getState();
    expect(s.queue[s.order[s.orderPos]].id).toBe(2);
    expect(level(1)).toBe(1); // the standby's node, now the playing one
  });

  it("a session that ends during the fade leaves the level whole", async () => {
    const { endPlayback, level } = await intoTheFade();
    endPlayback({ forget: false });
    expect(level()).toBe(1);
  });
});

describe("P2: claiming the session", () => {
  const compact = (t: Track) => [t.id, t.title, t.artist, t.album, t.duration, t.artwork_id, t.artist_id, t.album_id, t.gain_db];

  async function restoredAndPending(rows: Track[]) {
    localStorage.setItem(
      "flow.player.queue",
      JSON.stringify({ v: 2, rows: rows.map(compact), order: rows.map((_, i) => i), origin: null }),
    );
    let release: (v: unknown) => void = () => {};
    queueApi.fetchServerQueue.mockReturnValue(new Promise((r) => (release = r)));
    queueApi.saveServerQueue.mockImplementation((s: { tracks: unknown[] }) => Promise.resolve(s.tracks.length));
    // The server answers with its own rows: 7 is a favorite there.
    queueApi.claimServerQueue.mockImplementation((s: { tracks: Track[]; order: number[] }) =>
      Promise.resolve({ items: s.tracks.map((t) => ({ ...t, favorite: t.id === 7 })), order: s.order, order_pos: 0, position: 0, origin: null }),
    );
    const mod = await importPlayer();
    return { ...mod, release };
  }
  const serverSession = { status: "session", snapshot: { items: [track(99)], order: [0], order_pos: 0, position: 0, origin: null } };

  it("a favorite song is still a favorite once its row is vouched for", async () => {
    // What this browser saves for a favorite song (the compact row has no `favorite`).
    const { usePlayerStore, trackIsUnverified, release } = await restoredAndPending([track(7, { favorite: true }), track(8)]);
    usePlayerStore.setState({ isPlaying: true });
    release(serverSession);
    await flush();
    await flush();
    const row = usePlayerStore.getState().queue[0];
    expect(trackIsUnverified(row)).toBe(false); // vouched: the heart is shown
    expect(row.favorite).toBe(true); // ...and must show the truth
  });

  it("Undo of a Play Next made before the answer still removes the song", async () => {
    const { usePlayerStore, useUiStore, release } = await restoredAndPending([track(7), track(8)]);
    usePlayerStore.getState().playNext(track(50));
    expect(usePlayerStore.getState().queue.map((t: Track) => t.id)).toEqual([7, 50, 8]);
    const undo = useUiStore.getState().undoNotice?.undo;
    release(serverSession);
    await flush();
    await flush();
    await undo?.();
    expect(usePlayerStore.getState().queue.map((t: Track) => t.id)).toEqual([7, 8]);
  });
});

describe("what counts as a play, across a reconnect", () => {
  it("a blip after the stamp does not stamp the same listen again", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    const time = clock(elements[0]);
    elements[0].dispatchEvent(new Event("play"));
    time.listen(31);
    expect(stamps()).toEqual([1]);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fail(elements[0], 2);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await flush();
    time.listen(31);
    expect(stamps()).toEqual([1]);
  });

  it("a blip before the stamp does not throw away what was heard", async () => {
    const { usePlayerStore } = await importPlayer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    const time = clock(elements[0]);
    elements[0].dispatchEvent(new Event("play"));
    time.listen(25);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fail(elements[0], 2);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await flush();
    elements[0].dispatchEvent(new Event("play")); // the resumed element plays again
    time.listen(10); // 35 s heard in total
    expect(stamps()).toEqual([1]);
  });
});

describe("sign-out", () => {
  it("leaves nothing of the session in storage a few seconds later", async () => {
    const { usePlayerStore, endPlayback } = await importPlayer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    const time = clock(elements[0]);
    elements[0].dispatchEvent(new Event("play"));
    await vi.advanceTimersByTimeAsync(1000);
    time.listen(2); // playing: a playhead save is pending
    expect(localStorage.getItem("flow.player.queue")).not.toBeNull();
    queueApi.saveServerPlayhead.mockClear();
    queueApi.saveServerQueue.mockClear();

    endPlayback({ forget: true });
    await vi.advanceTimersByTimeAsync(5000);

    expect(localStorage.getItem("flow.player.queue")).toBeNull();
    expect(localStorage.getItem("flow.player.playhead")).toBeNull();
    expect(queueApi.saveServerPlayhead).not.toHaveBeenCalled();
    expect(queueApi.saveServerQueue).not.toHaveBeenCalled();
  });

  it("a queue edit made just before signing out is not sent as an empty queue afterwards", async () => {
    const { usePlayerStore, endPlayback } = await importPlayer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    await vi.advanceTimersByTimeAsync(1000);
    queueApi.saveServerQueue.mockClear();
    usePlayerStore.getState().playTracks([track(3), track(4)], 0); // 400 ms debounce pending
    endPlayback({ forget: true });
    await vi.advanceTimersByTimeAsync(1000);
    const sent = queueApi.saveServerQueue.mock.calls.map(([s]) => (s as { tracks: unknown[] }).tracks.length);
    expect(sent).toEqual([]);
  });

  it("after sign-out the element no longer holds the song (Play cannot resume it)", async () => {
    const { usePlayerStore, endPlayback } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    endPlayback({ forget: true });
    expect(usePlayerStore.getState().duration).toBe(0);
    expect(usePlayerStore.getState().buffered).toBe(0);
    expect(usePlayerStore.getState().buffering).toBe(false);
  });
});

describe("clear, play something else, undo", () => {
  it("the undo does not put the old song's name over the new song's sound", async () => {
    const { usePlayerStore, useUiStore } = await importPlayer();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    usePlayerStore.getState().clearQueue();
    const undo = useUiStore.getState().undoNotice?.undo;
    usePlayerStore.getState().playTracks([track(9)], 0);
    await undo?.();
    const s = usePlayerStore.getState();
    const current = s.queue[s.order[s.orderPos]];
    expect(elements[0].src).toContain(`/api/stream/${current.id}`);
  });
});

describe("album level", () => {
  it("a song added from another album is not levelled by the album that is playing", async () => {
    const contexts = stubAudioContext();
    const { usePlayerStore } = await importPlayer();
    const a1 = track(1, { album_id: 1, gain_db: -6 });
    const a2 = track(2, { album_id: 1, gain_db: 2 });
    const other = track(3, { album_id: null, gain_db: 3 });
    const other2 = track(4, { album_id: null, gain_db: -8 });
    usePlayerStore.getState().playTracks([a1, a2], 0, { kind: "album", label: "A", href: "/albums/1" });
    usePlayerStore.getState().addToQueue([other, other2]);
    usePlayerStore.getState().playAt(2);
    // Two loose singles (no album) are not one album.
    expect(contexts[0].gains[0].value).toBeCloseTo(Math.pow(10, 3 / 20), 3);
  });
});
