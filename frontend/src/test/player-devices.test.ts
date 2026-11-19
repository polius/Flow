/* One queue, several devices (P3): refused by the server, this device
   asks instead of overwriting; the listener acting here claims the queue;
   an automatic song change never does; Keep Listening Here writes nothing;
   Take Over sends the whole queue; repeat travels with the queue. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "../api/types";

const queueApi = vi.hoisted(() => ({
  claimServerQueue: vi.fn(),
  fetchServerQueue: vi.fn(),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
}));
vi.mock("../api/queue", () => queueApi);
vi.mock("../api/client", () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), use: vi.fn() },
}));

const track = (id: number): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: id,
  disc_no: 1,
  year: 2026,
  duration: 200,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: `t${id}.mp3`,
  gain_db: null,
  played_at: null,
});

let elements: HTMLAudioElement[] = [];

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(queueApi)) fn.mockReset();
  queueApi.fetchServerQueue.mockResolvedValue({ status: "empty" });
  elements = [];
  const RealAudio = window.Audio;
  vi.stubGlobal("Audio", function () {
    const el = new RealAudio();
    el.play = vi.fn(() => Promise.resolve());
    el.pause = vi.fn();
    el.load = vi.fn();
    Object.defineProperty(el, "paused", { configurable: true, get: () => true });
    elements.push(el);
    return el;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function setup() {
  vi.resetModules();
  const player = await import("../stores/player");
  const conflict = await import("../lib/queueConflict");
  await new Promise((r) => setTimeout(r, 0));
  return { ...player, ...conflict };
}

const claims = () =>
  queueApi.saveServerPlayhead.mock.calls.filter(([p]) => (p as { claim?: boolean }).claim);

describe("another device holds the queue", () => {
  it("asks instead of writing, and acting here claims the queue back", async () => {
    const { usePlayerStore, reportQueueConflict } = await setup();
    usePlayerStore.getState().playTracks([track(1), track(2), track(3)], 0);
    await new Promise((r) => setTimeout(r, 450)); // the plan mirror has gone out
    reportQueueConflict();
    expect(usePlayerStore.getState().elsewhere).toBe(true);

    // The playhead keeps moving here, but nothing goes to the server.
    queueApi.saveServerPlayhead.mockClear();
    elements[0].dispatchEvent(new Event("play")); // e.g. an automatic song change
    expect(queueApi.saveServerPlayhead).not.toHaveBeenCalled();

    // Next is the listener acting here: the next write claims the queue.
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().elsewhere).toBe(false);
    elements[0].dispatchEvent(new Event("play"));
    expect(claims()).toHaveLength(1);
  });

  it("Keep Listening Here writes nothing; Take Over sends the whole queue", async () => {
    const { usePlayerStore, reportQueueConflict } = await setup();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    await new Promise((r) => setTimeout(r, 450));
    reportQueueConflict();
    expect(usePlayerStore.getState().elsewhere).toBe(true);
    usePlayerStore.getState().keepListeningHere();
    expect(usePlayerStore.getState().elsewhere).toBe(false);
    reportQueueConflict(); // a late refusal does not ask again
    expect(usePlayerStore.getState().elsewhere).toBe(false);
    queueApi.saveServerPlayhead.mockClear();
    elements[0].dispatchEvent(new Event("play"));
    expect(queueApi.saveServerPlayhead).not.toHaveBeenCalled();

    queueApi.saveServerQueue.mockClear();
    usePlayerStore.getState().takeOver();
    expect(queueApi.saveServerQueue).toHaveBeenCalledTimes(1);
    const sent = queueApi.saveServerQueue.mock.calls[0][0] as { tracks: Track[]; shuffle: boolean; repeat: string };
    expect(sent.tracks.map((t) => t.id)).toEqual([1, 2]);
    expect(sent).toMatchObject({ shuffle: false, repeat: "off" });
  });

  it("repeat travels with the queue", async () => {
    const { usePlayerStore } = await setup();
    usePlayerStore.getState().playTracks([track(1)], 0);
    queueApi.saveServerPlayhead.mockClear();
    usePlayerStore.getState().cycleRepeat();
    expect(queueApi.saveServerPlayhead).toHaveBeenCalledWith({ repeat: "all" });
  });

  it("adopting the server's queue takes its switches", async () => {
    queueApi.fetchServerQueue.mockResolvedValue({
      status: "session",
      snapshot: {
        items: [track(1), track(2)],
        order: [1, 0],
        order_pos: 0,
        position: 0,
        shuffle: true,
        repeat: "one",
      },
    });
    const { usePlayerStore } = await setup();
    await new Promise((r) => setTimeout(r, 0));
    expect(usePlayerStore.getState()).toMatchObject({ shuffle: true, repeat: "one" });
  });

  it("a refusal right after acting here takes the queue over with the whole queue", async () => {
    const { usePlayerStore, reportQueueConflict } = await setup();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0);
    await new Promise((r) => setTimeout(r, 450)); // the plan mirror has gone out
    queueApi.saveServerQueue.mockClear();
    reportQueueConflict(true);
    expect(queueApi.saveServerQueue).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().elsewhere).toBe(false);
  });

  it("a refusal while this device's own new queue is on its way is not another device", async () => {
    const { usePlayerStore, reportQueueConflict } = await setup();
    usePlayerStore.getState().playTracks([track(1), track(2)], 0); // mirror pending (400 ms)
    reportQueueConflict();
    expect(usePlayerStore.getState().elsewhere).toBe(false);
  });
});
