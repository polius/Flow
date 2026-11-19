/* Server-truth queue sync. The store remains the source of UI truth;
   these helpers are its mirror and its restore path. An empty answer from
   a reachable server is the truth "nothing is playing"; silence is not. */

import { reportQueueConflict } from "../lib/queueConflict";
import { api } from "./client";
import type { QueueOrigin, QueueSnapshot, Track } from "./types";

export type ServerQueueSnapshot = QueueSnapshot;

/* One queue, several devices (P3). This browser's id rides every write;
   the server refuses (409) a write from a device that no longer holds the
   queue, and the store hears of it through the conflict handler. Tabs of
   one browser share the id: they coordinate among themselves. */
const DEVICE_KEY = "flow.device";
let device: string | null = null;

export function deviceId(): string {
  if (device != null) return device;
  try {
    device = localStorage.getItem(DEVICE_KEY);
    if (!device) {
      device =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, device);
    }
  } catch {
    device ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return device;
}

function heard(response: Response, acted = false): Response {
  if (response.status === 409) reportQueueConflict(acted);
  return response;
}

/** The things GET /api/queue can tell the restore path. */
export type ServerQueueState =
  | { status: "session"; snapshot: QueueSnapshot }
  | { status: "empty" } // reachable; no stored session (first run, or reset)
  | { status: "unauthorized" } // Login is on and this browser isn't signed in yet
  | { status: "unreachable" }; // no answer — the server cannot vouch either way

/** GET /api/queue — the stored session. A 200 with no items is a real
    answer ("empty"); anything else the server fails to answer with is
    "unreachable": only a real answer may clear. */
export async function fetchServerQueue(): Promise<ServerQueueState> {
  try {
    const { data, response } = await api.GET("/api/queue");
    // Refused, not silent: the restore waits for sign-in instead of
    // burning its retries against a wall.
    if (response.status === 401) return { status: "unauthorized" };
    // An erroring server (4xx/5xx) is not a real answer — it cannot vouch
    // for the library either way, so the local layer stays in charge.
    if (!response.ok) return { status: "unreachable" };
    if (!data || data.items.length === 0) return { status: "empty" };
    return { status: "session", snapshot: data };
  } catch {
    return { status: "unreachable" };
  }
}

/** POST /api/queue — "play this view": the server resolves the whole
    filter (or track list), builds the play order — shuffled when asked —
    and starts at `start`. `origin` records what the view is, so every
    surface can say "Playing from …". Returns the snapshot to adopt, or
    null when the server couldn't serve it (the caller falls back to a
    client-side whole-view fetch). */
export async function playByFilter(params: {
  q?: string;
  favorite?: boolean;
  genreId?: number;
  trackIds?: number[];
  sort: string;
  dir: string;
  start: number;
  shuffle?: boolean;
  origin?: QueueOrigin | null;
}): Promise<QueueSnapshot | null> {
  try {
    const { data, response } = await api.POST("/api/queue", {
      body: {
        sort: params.sort,
        dir: params.dir as "asc" | "desc",
        start: params.start,
        shuffle: !!params.shuffle,
        ...(params.trackIds ? { track_ids: params.trackIds } : {}),
        ...(params.q ? { q: params.q } : {}),
        ...(params.favorite ? { favorite: true } : {}),
        ...(params.genreId != null ? { genre_id: params.genreId } : {}),
        ...(params.origin ? { origin: params.origin } : {}),
        device: deviceId(),
      },
    });
    if (!response.ok || !data || data.items.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/** PUT /api/queue — mirror the client's plan. Never throws: persistence
    is best-effort by contract. The origin rides along so the server's
    copy keeps saying "Playing from …" after every plan change.
    `keepalive` lets the pagehide flush survive tab close. `?minimal=1`
    asks for `{updated_at, count}` back instead of the whole snapshot —
    the mirror never reads the echo, and a 20k-row TrackOut list per edit
    was megabytes for nothing. */
export function saveServerQueue(
  snapshot: {
    tracks: Track[];
    order: number[];
    orderPos: number;
    position: number;
    origin?: QueueOrigin | null;
    shuffle?: boolean;
    repeat?: "off" | "all" | "one";
  },
  keepalive = false,
): Promise<number | null> {
  return api
    .PUT("/api/queue", {
      params: { query: { minimal: true } },
      // The contract spells the flag `1` (a bool or an int param reads it
      // alike); the default serializer would send `true`.
      querySerializer: () => "minimal=1",
      body: {
        track_ids: snapshot.tracks.map((t) => t.id),
        order: snapshot.order,
        order_pos: snapshot.orderPos,
        position: snapshot.position,
        ...(snapshot.origin ? { origin: snapshot.origin } : {}),
        ...(snapshot.shuffle != null ? { shuffle: snapshot.shuffle } : {}),
        ...(snapshot.repeat != null ? { repeat: snapshot.repeat } : {}),
        device: deviceId(),
      },
      ...(keepalive ? { keepalive: true } : {}),
    })
    .then(({ data, response }) => (heard(response), data))
    .then((data) =>
      // How many entries the server stored: ids a scan removed are dropped.
      data != null && "count" in data ? data.count : null,
    )
    .catch(() => {
      // Offline / server restart / blip: localStorage still holds the
      // session; the next plan change mirrors again.
      return null;
    });
}

/** PUT /api/queue, answered with what the server stored: its own rows
    (current favorites and links), without any song a scan removed. The
    claim of a session begun before the server's copy arrived uses it.
    null when the server did not store it. */
export function claimServerQueue(snapshot: {
  tracks: Track[];
  order: number[];
  orderPos: number;
  position: number;
  origin?: QueueOrigin | null;
  shuffle?: boolean;
  repeat?: "off" | "all" | "one";
}): Promise<QueueSnapshot | null> {
  return api
    .PUT("/api/queue", {
      body: {
        track_ids: snapshot.tracks.map((t) => t.id),
        order: snapshot.order,
        order_pos: snapshot.orderPos,
        position: snapshot.position,
        ...(snapshot.origin ? { origin: snapshot.origin } : {}),
        ...(snapshot.shuffle != null ? { shuffle: snapshot.shuffle } : {}),
        ...(snapshot.repeat != null ? { repeat: snapshot.repeat } : {}),
        device: deviceId(),
      },
    })
    .then(({ data }) => (data != null && "items" in data ? data : null))
    .catch(() => null);
}

/** PATCH /api/queue — the playhead. `playedTrackId` rides the immediate
    start-of-play sync so the server can stamp played_at on the track
    that actually started — carried, never derived from stored state. */
export function saveServerPlayhead(
  patch: {
    orderPos?: number;
    position?: number;
    playedTrackId?: number;
    /** The counted listen's id (sent with its stamp; a retry reuses it). */
    listenId?: string;
    /** Written right after the listener acted here: a refusal means
        "take the queue over", not "ask". */
    claim?: boolean;
    repeat?: "off" | "all" | "one";
  },
  keepalive = false,
): void {
  const send = (ka: boolean): Promise<boolean> =>
    api
      .PATCH("/api/queue", {
        body: {
          ...(patch.orderPos != null ? { order_pos: patch.orderPos } : {}),
          ...(patch.position != null ? { position: patch.position } : {}),
          ...(patch.playedTrackId != null
            ? { played_track_id: patch.playedTrackId }
            : {}),
          ...(patch.listenId != null ? { listen_id: patch.listenId } : {}),
          ...(patch.repeat != null ? { repeat: patch.repeat } : {}),
          device: deviceId(),
        },
        ...(ka ? { keepalive: true } : {}),
      })
      .then(({ response }) => heard(response, !!patch.claim).ok)
      .catch(() => {
        // Same best-effort story as every other write here. The 3 s cadence
        // keeps the playhead converging; only the stamp needs a retry, and
        // only this sync carries one.
        return false;
      });
  const first = send(keepalive);
  // A lost stamp would silently thin the play record (the position ticks
  // that follow never carry a track id). One quiet retry — past a
  // scanner's commit window, which can hold the write lock for seconds —
  // and only when the first did not land: every stamp the server takes is
  // one play in the history.
  if (patch.playedTrackId != null) {
    void first.then((ok) => {
      if (!ok) window.setTimeout(() => void send(false), 2500);
    });
  }
}
