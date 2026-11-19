/* With Login on, the boot-time requests meet a 401: the scan stream must
   not die for good on it (EventSource treats an HTTP error as fatal), and
   the server-queue adoption must wait for sign-in rather than burn its
   retries. A finished scan refreshes the whole library, once. */

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
  title: `Server Track ${id}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: 1,
  disc_no: 1,
  year: 2026,
  duration: 60,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: `t-${id}.mp3`,
  gain_db: null,
  played_at: null,
});

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  clientApi.api.GET.mockResolvedValue({ data: undefined, response: new Response(null) });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("scan stream", () => {
  it("reopens after the server refuses it, and stops on sign-out", async () => {
    vi.useFakeTimers();
    const { ensureScanSync, stopScanSync } = await import("../api/scanSync");
    ensureScanSync();
    expect(FakeEventSource.instances).toHaveLength(1);

    // A 401: EventSource gives up (CLOSED) — the sync reopens later.
    const first = FakeEventSource.instances[0];
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    vi.advanceTimersByTime(2500);
    expect(FakeEventSource.instances).toHaveLength(2);

    stopScanSync();
    expect(FakeEventSource.instances[1].closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("a scan finishing refreshes the library once", async () => {
    const { ensureScanSync, stopScanSync } = await import("../api/scanSync");
    const { queryClient } = await import("../api/queryClient");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    ensureScanSync();
    const source = FakeEventSource.instances[0];
    const event = (state: string) => ({
      data: JSON.stringify({
        type: "state",
        state,
        phase: state === "scanning" ? "scan" : null,
        current: 0,
        total: 0,
        errors: 0,
        finished_at: null,
      }),
    });
    source.onmessage?.(event("idle")); // connect-time idle: nothing changed
    expect(invalidate).not.toHaveBeenCalled();
    source.onmessage?.(event("scanning"));
    source.onmessage?.(event("idle"));
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(["albums", "tracks", "settings", "search"]));
    stopScanSync();
  });
});

describe("scan stream while hidden", () => {
  const snapshot = (state: string, phase: string | null, finished: string | null) => ({
    data: {
      library_path: "/music",
      library_exists: true,
      scan: { state, phase, current: 0, total: 0, errors: 0, finished_at: finished, mount_guard: false },
      counts: { tracks: 1, albums: 1, artists: 1, playlists: 0 },
    },
    response: new Response(null),
  });
  const setVisibility = (v: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it("closes when hidden, and catches up on a scan that ran meanwhile", async () => {
    vi.useFakeTimers();
    clientApi.api.GET.mockResolvedValue(snapshot("idle", null, "2026-01-01T00:00:00Z"));
    const { ensureScanSync, stopScanSync } = await import("../api/scanSync");
    const { queryClient } = await import("../api/queryClient");
    ensureScanSync();
    await vi.advanceTimersByTimeAsync(10);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    setVisibility("hidden");
    expect(FakeEventSource.instances[0].closed).toBe(true);

    // A scan started and finished while the tab was hidden.
    clientApi.api.GET.mockResolvedValue(snapshot("idle", null, "2026-01-01T00:05:00Z"));
    await vi.advanceTimersByTimeAsync(3000); // past the snapshot's 2 s reuse
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeEventSource.instances).toHaveLength(2);
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(["albums", "tracks"]));
    stopScanSync();
    setVisibility("visible");
  });

  it("a failed snapshot is not an unhandled error", async () => {
    clientApi.api.GET.mockResolvedValue({ data: undefined, response: new Response(null, { status: 502 }) });
    const { ensureScanSync, stopScanSync } = await import("../api/scanSync");
    ensureScanSync();
    await new Promise((r) => setTimeout(r, 0));
    stopScanSync();
  });
});

describe("server-queue adoption", () => {
  it("waits for sign-in instead of giving up", async () => {
    queueApi.fetchServerQueue.mockResolvedValueOnce({ status: "unauthorized" });
    const { usePlayerStore, resumeServerAdoption } = await import("../stores/player");
    await new Promise((r) => setTimeout(r, 0));
    expect(usePlayerStore.getState().queue).toEqual([]);

    queueApi.fetchServerQueue.mockResolvedValueOnce({
      status: "session",
      snapshot: {
        items: [track(1), track(2)],
        order: [0, 1],
        order_pos: 1,
        position: 9,
        updated_at: "2026-10-01T00:00:00+00:00",
      },
    });
    resumeServerAdoption(); // AppShell: the status says signed in
    await new Promise((r) => setTimeout(r, 0));
    const s = usePlayerStore.getState();
    expect(s.queue.map((t) => t.id)).toEqual([1, 2]);
    expect(s.orderPos).toBe(1);

    // Only a refused adoption resumes: a second call is a no-op.
    resumeServerAdoption();
    expect(queueApi.fetchServerQueue).toHaveBeenCalledTimes(2);
  });
});
