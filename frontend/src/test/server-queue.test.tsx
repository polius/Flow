/* Server-truth queue restore (§32 + §2.7): the store restores the §29
   localStorage snapshot synchronously, then adopts the server's session
   over it when it arrives while the local one is still untouched. The
   server is the truth; the local layer is the offline fallback; a session
   already begun here is never clobbered. And since §2.7, a REACHABLE
   server's empty answer is authoritative for CLEARING (a stale snapshot
   from another library must not resurrect), while an unreachable one
   degrades to §29 with its rows marked unverified — restored rows render
   text, not links, until the server vouches for them.

   The restore runs at module load, so each case re-imports the player store
   (vi.resetModules + dynamic import) with the queue API mocked — the
   transport can't run under jsdom (relative-URL Request), and the behavior
   under test is the store's precedence, not the transport. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "../api/types";

const queueApi = vi.hoisted(() => ({
  fetchServerQueue: vi.fn(),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
}));

vi.mock("../api/queue", () => queueApi);

const TRACKS: Track[] = [1, 2, 3].map((i) => ({
  id: 100 + i,
  title: `Server Track ${i}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: i,
  disc_no: 1,
  year: 2026,
  duration: 60,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: `server/track-${i}.mp3`,
  gain_db: null,
  played_at: null,
}));

function serverSnapshot(orderPos: number, position = 12) {
  return {
    items: TRACKS,
    order: [0, 1, 2],
    order_pos: orderPos,
    position,
    updated_at: "2026-10-01T00:00:00+00:00",
  };
}

const session = (orderPos: number, position?: number) => ({
  status: "session" as const,
  snapshot: serverSnapshot(orderPos, position),
});

beforeEach(() => {
  localStorage.clear();
  queueApi.fetchServerQueue.mockReset();
  queueApi.saveServerQueue.mockReset();
  queueApi.saveServerPlayhead.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

async function importPlayerStore() {
  vi.resetModules();
  const mod = await import("../stores/player");
  // Let the async server adoption (fired at module load, after the persist
  // middleware's rehydration) settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}

describe("server-queue restore (§32)", () => {
  it("adopts the server session when this browser has none", async () => {
    queueApi.fetchServerQueue.mockResolvedValue(session(1));
    const { usePlayerStore } = await importPlayerStore();
    const s = usePlayerStore.getState();
    expect(s.queue.map((t) => t.title)).toEqual([
      "Server Track 1",
      "Server Track 2",
      "Server Track 3",
    ]);
    expect(s.orderPos).toBe(1);
    expect(s.position).toBe(12);
    // Restores are always paused (§29): the bar is that state loss is never
    // total, never that sound starts uninvited.
    expect(s.isPlaying).toBe(false);
  });

  it("the server's plan replaces a stale local copy when untouched", async () => {
    const local = [{ ...TRACKS[0], id: 7, title: "Local Track" }];
    localStorage.setItem(
      "flow.player.queue",
      JSON.stringify({ queue: local, order: [0] }),
    );
    localStorage.setItem(
      "flow.player.playhead",
      JSON.stringify({ orderPos: 0, position: 0, savedAt: Date.now() }),
    );
    queueApi.fetchServerQueue.mockResolvedValue(session(1));

    const { usePlayerStore } = await importPlayerStore();
    // An untouched first paint should show the server's truth, not this
    // browser's stale copy.
    expect(usePlayerStore.getState().queue[0]?.id).toBe(101);
  });

  it("a session already begun here is never clobbered by the server", async () => {
    const local = [{ ...TRACKS[0], id: 7, title: "Local Track" }];
    localStorage.setItem(
      "flow.player.queue",
      JSON.stringify({ queue: local, order: [0] }),
    );

    // Defer the server answer until after the user has acted.
    let release: (value: ReturnType<typeof session>) => void = () => {};
    queueApi.fetchServerQueue.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const { usePlayerStore } = await import("../stores/player");
    expect(usePlayerStore.getState().queue[0]?.title).toBe("Local Track");

    // The user acts before the server answers — pressing play makes this
    // session owned (an identity change, not a preference) — so the
    // adoption must not clobber it.
    usePlayerStore.setState({ isPlaying: true });
    release(session(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(usePlayerStore.getState().queue[0]?.title).toBe("Local Track");
  });

  it("an unreachable server degrades to the localStorage snapshot (§29), rows unverified", async () => {
    const local = [{ ...TRACKS[0], id: 7, title: "Local Track" }];
    localStorage.setItem(
      "flow.player.queue",
      JSON.stringify({ queue: local, order: [0] }),
    );
    localStorage.setItem(
      "flow.player.playhead",
      JSON.stringify({ orderPos: 0, position: 3, savedAt: Date.now() }),
    );
    queueApi.fetchServerQueue.mockResolvedValue({ status: "unreachable" });

    const { usePlayerStore, trackIsUnverified } = await importPlayerStore();

    const s = usePlayerStore.getState();
    expect(s.queue[0]?.title).toBe("Local Track");
    expect(s.position).toBe(3);
    // §2.7: no answer means nothing is vouched for — surfaces must render
    // the restored row's names as text, not links.
    expect(trackIsUnverified(s.queue[0])).toBe(true);
  });

  it("an empty session from a reachable server CLEARS a stale local snapshot (§2.7)", async () => {
    // The observed failure: a snapshot from a previous, different library
    // resurrected rows whose ids no longer exist. The server answered —
    // its truth is "nothing is playing" — so the stale copy goes, keys
    // and all (or the next reload restores the same ghosts).
    const local = [{ ...TRACKS[0], id: 7, title: "Local Track" }];
    localStorage.setItem(
      "flow.player.queue",
      JSON.stringify({ queue: local, order: [0] }),
    );
    localStorage.setItem(
      "flow.player.playhead",
      JSON.stringify({ orderPos: 0, position: 3, savedAt: Date.now() }),
    );
    queueApi.fetchServerQueue.mockResolvedValue({ status: "empty" });

    const { usePlayerStore } = await importPlayerStore();

    const s = usePlayerStore.getState();
    expect(s.queue).toEqual([]);
    expect(s.origin).toBeNull();
    expect(localStorage.getItem("flow.player.queue")).toBeNull();
    expect(localStorage.getItem("flow.player.playhead")).toBeNull();
  });

  it("adopting the server's session vouches for its rows (links render)", async () => {
    queueApi.fetchServerQueue.mockResolvedValue(session(1));
    const { usePlayerStore, trackIsUnverified } = await importPlayerStore();
    expect(trackIsUnverified(usePlayerStore.getState().queue[0])).toBe(false);
  });

  it("plan changes mirror to the server; playhead stamps ride the start sync", async () => {
    queueApi.fetchServerQueue.mockResolvedValue(session(0));
    const { usePlayerStore } = await importPlayerStore();

    // A plan change (queue identity) schedules the debounced mirror —
    // time-travel past the 400 ms debounce.
    usePlayerStore.setState({ queue: TRACKS, order: [0, 1, 2] });
    await new Promise((r) => setTimeout(r, 450));

    expect(queueApi.saveServerQueue).toHaveBeenCalled();
    const arg = queueApi.saveServerQueue.mock.calls.at(-1)?.[0];
    expect(arg.tracks.map((t: Track) => t.id)).toEqual([101, 102, 103]);
    expect(arg.order).toEqual([0, 1, 2]);
  });
});
