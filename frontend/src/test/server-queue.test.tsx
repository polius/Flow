/* Server-truth queue restore: the store restores the localStorage snapshot
   synchronously, then adopts the server's session over it when it arrives
   while the local one is still untouched. A reachable server's empty answer
   is authoritative for CLEARING (a stale snapshot from another library must
   not resurrect); an unreachable one degrades to the local snapshot with
   its rows marked unverified — restored rows render text, not links, until
   the server vouches for them. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "../api/types";

const queueApi = vi.hoisted(() => ({
  claimServerQueue: vi.fn(),
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
  queueApi.claimServerQueue.mockReset();
  queueApi.saveServerQueue.mockReset();
  queueApi.saveServerPlayhead.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

async function importPlayerStore() {
  vi.resetModules();
  const mod = await import("../stores/player");
  // The restore runs at module load, so each case re-imports the store with
  // the queue API mocked (the transport can't run under jsdom) — the
  // behavior under test is the store's precedence, not the transport. Let
  // the async server adoption settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}

describe("server-queue restore", () => {
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
    // Restores are always paused: the bar is that state loss is never
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
    // session owned, so the adoption must not clobber it.
    usePlayerStore.setState({ isPlaying: true });
    release(session(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(usePlayerStore.getState().queue[0]?.title).toBe("Local Track");
  });

  it("pressing play before the saved queue arrives sends this queue up and takes the server's rows", async () => {
    const local = [
      { ...TRACKS[0], id: 7, title: "Local One" },
      { ...TRACKS[0], id: 8, title: "Local Two" },
    ];
    // The compact local copy carries no heart: song 8 reads "not favorite".
    localStorage.setItem(
      "flow.player.queue",
      JSON.stringify({ queue: local, order: [0, 1] }),
    );
    let release: (value: ReturnType<typeof session>) => void = () => {};
    queueApi.fetchServerQueue.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    // The server stores both rows and answers with its own: 8 is a favorite.
    queueApi.claimServerQueue.mockResolvedValue({
      ...serverSnapshot(1),
      items: [
        { ...TRACKS[0], id: 7, title: "Local One" },
        { ...TRACKS[0], id: 8, title: "Local Two", favorite: true },
      ],
      order: [0, 1],
    });

    const { usePlayerStore, trackIsUnverified } = await import("../stores/player");
    expect(trackIsUnverified(usePlayerStore.getState().queue[0])).toBe(true);

    // Play, on the restored queue: no plan change, so nothing mirrored yet.
    usePlayerStore.setState({ isPlaying: true, orderPos: 1 });
    expect(queueApi.claimServerQueue).not.toHaveBeenCalled();

    release(session(1)); // the server still held a different queue
    await new Promise((r) => setTimeout(r, 0));

    // The queue that is playing is the one the server now holds...
    expect(queueApi.claimServerQueue).toHaveBeenCalledTimes(1);
    const sent = queueApi.claimServerQueue.mock.calls[0][0] as {
      tracks: { id: number }[];
      orderPos: number;
    };
    expect(sent.tracks.map((t) => t.id)).toEqual([7, 8]);
    expect(sent.orderPos).toBe(1);
    // ...it was not replaced, its rows are vouched for (links, the heart
    // and L work), and the heart says what the server knows.
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.title)).toEqual(["Local One", "Local Two"]);
    expect(state.orderPos).toBe(1);
    expect(state.queue.some((t) => trackIsUnverified(t))).toBe(false);
    expect(state.queue[1].favorite).toBe(true);
    expect(queueApi.saveServerQueue).not.toHaveBeenCalled(); // nothing to correct
  });

  it("a song a scan removed leaves the queue, and the positions follow the server's", async () => {
    localStorage.setItem(
      "flow.player.queue",
      JSON.stringify({
        queue: [{ ...TRACKS[0], id: 7 }, { ...TRACKS[0], id: 8 }, { ...TRACKS[0], id: 9 }],
        order: [0, 1, 2],
      }),
    );
    let release: (value: ReturnType<typeof session>) => void = () => {};
    queueApi.fetchServerQueue.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    // Song 8 no longer exists: the server stores 7 and 9.
    queueApi.claimServerQueue.mockResolvedValue({
      ...serverSnapshot(1),
      items: [
        { ...TRACKS[0], id: 7 },
        { ...TRACKS[0], id: 9 },
      ],
      order: [0, 1],
    });

    const { usePlayerStore, trackIsUnverified } = await import("../stores/player");
    usePlayerStore.setState({ isPlaying: true, orderPos: 2 }); // playing song 9
    release(session(1));
    await new Promise((r) => setTimeout(r, 0));

    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual([7, 9]);
    expect(state.queue[state.order[state.orderPos]].id).toBe(9);
    expect(state.orderPos).toBe(1);
    expect(state.queue.some((t) => trackIsUnverified(t))).toBe(false);
    // The browser's numbering is the server's again: one more mirror says so.
    const mirrored = queueApi.saveServerQueue.mock.calls.at(-1)?.[0] as {
      tracks: { id: number }[];
      orderPos: number;
    };
    expect(mirrored.tracks.map((t) => t.id)).toEqual([7, 9]);
    expect(mirrored.orderPos).toBe(1);
  });

  it("an unreachable server degrades to the localStorage snapshot, rows unverified", async () => {
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
    // No answer means nothing is vouched for — surfaces must render the
    // restored row's names as text, not links.
    expect(trackIsUnverified(s.queue[0])).toBe(true);
  });

  it("an empty session from a reachable server CLEARS a stale local snapshot", async () => {
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
    const arg = queueApi.saveServerQueue.mock.calls.at(-1)?.[0] as {
      tracks: Track[];
      order: number[];
    };
    expect(arg.tracks.map((t: Track) => t.id)).toEqual([101, 102, 103]);
    expect(arg.order).toEqual([0, 1, 2]);
  });
});
