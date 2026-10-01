/* Server-truth queue sync (UX review Part 4.0, DESIGN.md §32).
   The store remains the source of UI truth; these helpers are its mirror
   and its restore path:

   - fetchServerQueue  GET on load — the session, or null when the server
     has none (first run) or can't be reached. Callers fall back to the
     §29 localStorage snapshot; the server is the truth, not a single
     point of failure.
   - playByFilter      POST — "play this view" resolves the WHOLE filter
     server-side (§1.2 for good: there is no page to truncate to).
   - saveServerQueue   PUT — the plan mirror, debounced by the store at the
     §29 cadence. Fire-and-forget: a LAN blip must never cost the UI
     anything, and the localStorage layer still has the session.
   - saveServerPlayhead PATCH — the tiny playhead write; `keepalive` lets
     the pagehide flush survive tab close. */

import { api } from "./client";
import type { QueueSnapshot, Track } from "./types";

export type ServerQueueSnapshot = QueueSnapshot;

/** GET /api/queue — the stored session, healed and canonical; null when
    empty or unreachable. */
export async function fetchServerQueue(): Promise<QueueSnapshot | null> {
  try {
    const { data, response } = await api.GET("/api/queue");
    if (!response.ok || !data || data.items.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/** POST /api/queue — "play this view" (§4.0): the server resolves the whole
    filter (or track list), builds the play order — shuffled when asked —
    and starts at `start`. Returns the snapshot to adopt, or null when the
    server couldn't serve it (the caller falls back to §29's client-side
    whole-view fetch). */
export async function playByFilter(params: {
  q?: string;
  favorite?: boolean;
  genreId?: number;
  trackIds?: number[];
  sort: string;
  dir: string;
  start: number;
  shuffle?: boolean;
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
    `keepalive` lets the pagehide flush survive tab close. */
export function saveServerQueue(
  snapshot: {
    tracks: Track[];
    order: number[];
    orderPos: number;
    position: number;
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
