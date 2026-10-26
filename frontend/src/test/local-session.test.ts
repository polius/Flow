/* The local session layer: a compact snapshot (ids + the few fields a
   paused row renders), v1.5.0's whole-object snapshot still restored and
   migrated, a failed queue write clearing BOTH keys (never a stale queue
   under a fresh playhead), and the multi-tab rules — an idle tab writes
   nothing on hide, and a tab that starts playing pauses the others. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "../api/types";

const queueApi = vi.hoisted(() => ({
  fetchServerQueue: vi.fn(),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
}));

vi.mock("../api/queue", () => queueApi);

HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};

const track = (id: number): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  artist_id: 3,
  album: "Album",
  album_id: 4,
  track_no: 1,
  disc_no: 1,
  year: 2026,
  duration: 60,
  format: "mp3",
  favorite: false,
  artwork_id: 5,
  path: `track-${id}.mp3`,
  gain_db: -6.5,
  played_at: null,
});

const QUEUE_KEY = "flow.player.queue";
const PLAYHEAD_KEY = "flow.player.playhead";

beforeEach(() => {
  localStorage.clear();
  queueApi.fetchServerQueue.mockReset();
  queueApi.saveServerQueue.mockReset();
  queueApi.saveServerPlayhead.mockReset();
  // The server can't vouch either way: the local layer stays in charge.
  queueApi.fetchServerQueue.mockResolvedValue({ status: "unreachable" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function importPlayerStore() {
  vi.resetModules();
  const mod = await import("../stores/player");
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("local snapshot", () => {
  it("restores v1.5.0's whole-object snapshot and migrates it compact", async () => {
    // Exactly what v1.5.0 wrote: full TrackOut objects under `queue`.
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({
        queue: [track(1), track(2)],
        order: [1, 0],
        origin: { kind: "album", label: "Album", href: "/albums/4" },
      }),
    );
    localStorage.setItem(PLAYHEAD_KEY, JSON.stringify({ orderPos: 1, position: 12 }));

    const { usePlayerStore } = await importPlayerStore();
    const s = usePlayerStore.getState();
    expect(s.queue.map((t) => t.id)).toEqual([1, 2]);
    expect(s.order).toEqual([1, 0]);
    expect(s.orderPos).toBe(1);
    expect(s.position).toBe(12);
    expect(s.origin?.label).toBe("Album");

    // Rewritten in the compact shape: no whole objects, no `queue` key
    // (v1.5.0 readers ignore it on a rollback instead of misreading it).
    const stored = JSON.parse(localStorage.getItem(QUEUE_KEY)!) as Record<string, unknown>;
    expect(stored.v).toBe(2);
    expect(stored.queue).toBeUndefined();
    expect(stored.rows).toEqual([
      [1, "Track 1", "Artist", "Album", 60, 5, 3, 4, -6.5],
      [2, "Track 2", "Artist", "Album", 60, 5, 3, 4, -6.5],
    ]);
    // Migration is local only: the server already holds this plan.
    expect(queueApi.saveServerQueue).not.toHaveBeenCalled();
  });

  it("round-trips the compact snapshot into renderable rows", async () => {
    let { usePlayerStore } = await importPlayerStore();
    usePlayerStore.getState().addToQueue([track(1), track(2), track(3)]);
    await settle(450); // past the debounced writer

    ({ usePlayerStore } = await importPlayerStore());
    const s = usePlayerStore.getState();
    expect(s.queue.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(s.queue[0]).toMatchObject({
      title: "Track 1",
      artist: "Artist",
      album: "Album",
      duration: 60,
      artwork_id: 5,
      gain_db: -6.5,
    });
  });

  it("never crashes on junk", async () => {
    for (const raw of [
      "{not json",
      "null",
      "42",
      JSON.stringify({ queue: [{ id: "x" }], order: [0] }),
      JSON.stringify({ v: 2, rows: [[1]], order: [0] }),
      JSON.stringify({ queue: [null], order: [0] }),
    ]) {
      localStorage.setItem(QUEUE_KEY, raw);
      const { usePlayerStore } = await importPlayerStore();
      expect(usePlayerStore.getState().queue).toEqual([]);
    }
  });

  it("a duplicated order index falls back to identity order", async () => {
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ queue: [track(1), track(2)], order: [0, 0] }),
    );
    const { usePlayerStore } = await importPlayerStore();
    expect(usePlayerStore.getState().order).toEqual([0, 1]);
  });

  it("a failed queue write clears both keys and stops playhead writes", async () => {
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ v: 2, rows: [[1, "Old", null, null, 60, null, null, null, null]], order: [0] }),
    );
    localStorage.setItem(PLAYHEAD_KEY, JSON.stringify({ orderPos: 0, position: 5 }));
    const { usePlayerStore } = await importPlayerStore();

    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === QUEUE_KEY) throw new DOMException("full", "QuotaExceededError");
      realSetItem.call(this, key, value);
    });

    usePlayerStore.getState().playTracks([track(7), track(8)], 1);
    await settle(450);

    // Neither the stale queue nor a playhead pointing into it survives.
    expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
    expect(localStorage.getItem(PLAYHEAD_KEY)).toBeNull();
    // The server mirror still got the plan.
    expect(queueApi.saveServerQueue).toHaveBeenCalled();
  });
});

describe("tabs", () => {
  it("an idle tab writes nothing when it hides", async () => {
    const { usePlayerStore } = await importPlayerStore();
    usePlayerStore.getState().addToQueue([track(1)]);
    await settle(450);
    queueApi.saveServerPlayhead.mockClear();
    queueApi.saveServerQueue.mockClear();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(queueApi.saveServerPlayhead).not.toHaveBeenCalled();
    expect(queueApi.saveServerQueue).not.toHaveBeenCalled();
  });

  it("works without BroadcastChannel (old Safari)", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const { usePlayerStore } = await importPlayerStore();
    expect(() => usePlayerStore.getState().playTracks([track(1)], 0)).not.toThrow();
  });

  it("another tab starting playback pauses this one", async () => {
    // Capture this module's audio elements and its channel.
    const elements: HTMLAudioElement[] = [];
    const RealAudio = window.Audio;
    vi.stubGlobal(
      "Audio",
      function () {
        const el = new RealAudio();
        elements.push(el);
        return el;
      },
    );
    const channels: FakeChannel[] = [];
    class FakeChannel {
      listeners: ((e: MessageEvent) => void)[] = [];
      constructor() {
        channels.push(this);
      }
      addEventListener(_: string, fn: (e: MessageEvent) => void) {
        this.listeners.push(fn);
      }
      postMessage() {}
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);

    await importPlayerStore();
    const [audio] = elements;
    const pause = vi.fn();
    Object.defineProperty(audio, "paused", { configurable: true, get: () => false });
    audio.pause = pause;

    for (const fn of channels[0].listeners) {
      fn(new MessageEvent("message", { data: { type: "playing", tab: "other-tab" } }));
    }
    expect(pause).toHaveBeenCalled();
  });
});
