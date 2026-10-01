/* Server-truth queue sync (UX review Part 4.0, DESIGN.md §32).
   The store remains the source of UI truth; these helpers are its mirror
   and its restore path:

   - fetchServerQueue  GET on load — the session, a verdict that the server
     HAS none (§2.7: authoritative for clearing), or a verdict that it
     can't be reached (the local layer stays in charge). The distinction
     matters: an empty answer from a reachable server is the truth
     "nothing is playing"; silence is not.
   - playByFilter      POST — "play this view" resolves the WHOLE filter
     server-side (§1.2 for good: there is no page to truncate to).
   - saveServerQueue   PUT — the plan mirror, debounced by the store at the
     §29 cadence. Fire-and-forget: a LAN blip must never cost the UI
     anything, and the localStorage layer still has the session.
   - saveServerPlayhead PATCH — the tiny playhead write; `keepalive` lets
     the pagehide flush survive tab close. */

import { api } from "./client";
import type { QueueOrigin, QueueSnapshot, Track } from "./types";

export type ServerQueueSnapshot = QueueSnapshot;

/** The three things GET /api/queue can tell the restore path. */
export type ServerQueueState =
  | { status: "session"; snapshot: QueueSnapshot }
  | { status: "empty" } // reachable; no stored session (first run, or reset)
  | { status: "unreachable" }; // no answer — the server cannot vouch either way

/** GET /api/queue — the stored session, healed and canonical. A 200 with
    no items is a real answer ("empty"); anything else the server fails to
    answer with is "unreachable" (§2.7): only a real answer may clear. */
export async function fetchServerQueue(): Promise<ServerQueueState> {
  try {
    const { data, response } = await api.GET("/api/queue");
    // An erroring server (4xx/5xx) is not a real answer — it cannot vouch
    // for the library either way, so the local layer stays in charge.
    if (!response.ok) return { status: "unreachable" };
    if (!data || data.items.length === 0) return { status: "empty" };
    return { status: "session", snapshot: data };
  } catch {
    return { status: "unreachable" };
  }
}

/** POST /api/queue — "play this view" (§32): the server resolves the whole
    filter (or track list), builds the play order — shuffled when asked —
    and starts at `start`. `origin` is the caller's declaration of what the
    view is (§1.1: the client knows; the server records, and every surface
    gets to say "Playing from …"). Returns the snapshot to adopt, or null
    when the server couldn't serve it (the caller falls back to §29's
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
      },
    });
    if (!response.ok || !data || data.items.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/** PUT /api/queue — mirror the client's plan. Never throws: persistence is
    best-effort by contract (§29's quota story, one layer further out).
    The origin rides along (§1.1): the server's canonical copy keeps saying
    "Playing from …" after every plan change. `keepalive` lets the pagehide
    flush survive tab close. */
export function saveServerQueue(
  snapshot: {
    tracks: Track[];
    order: number[];
    orderPos: number;
    position: number;
    origin?: QueueOrigin | null;
  },
  keepalive = false,
): void {
  void api
    .PUT("/api/queue", {
      body: {
        track_ids: snapshot.tracks.map((t) => t.id),
        order: snapshot.order,
        order_pos: snapshot.orderPos,
        position: snapshot.position,
        ...(snapshot.origin ? { origin: snapshot.origin } : {}),
      },
      ...(keepalive ? { keepalive: true } : {}),
    })
    .catch(() => {
      // Offline / server restart / blip: localStorage still holds the
      // session; the next plan change mirrors again.
    });
}

/** PATCH /api/queue — the playhead. `playedTrackId` rides the immediate
    start-of-play sync so the server can stamp played_at (§4.1) on the track
    that actually started — carried, never derived from stored state. */
export function saveServerPlayhead(
  patch: {
    orderPos?: number;
    position?: number;
    playedTrackId?: number;
  },
  keepalive = false,
): void {
  const send = (ka: boolean) =>
    api
      .PATCH("/api/queue", {
        body: {
          ...(patch.orderPos != null ? { order_pos: patch.orderPos } : {}),
          ...(patch.position != null ? { position: patch.position } : {}),
          ...(patch.playedTrackId != null
            ? { played_track_id: patch.playedTrackId }
            : {}),
        },
        ...(ka ? { keepalive: true } : {}),
      })
      .catch(() => {
        // Same best-effort story as every other write here. The 3 s cadence
        // keeps the playhead converging; only the stamp needs a retry, and
        // only this sync carries one.
      });
  void send(keepalive);
  // A lost start-of-play stamp would silently thin §4.1's record (the
  // position ticks that follow never carry a track id). One quiet retry —
  // past a scanner's commit window, which can hold the write lock for
  // seconds — keeps the record honest. Re-stamping is idempotent: recency
  // only.
  if (patch.playedTrackId != null) {
    window.setTimeout(() => void send(false), 2500);
  }
}
