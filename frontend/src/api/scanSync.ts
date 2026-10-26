/* Live scan-status sync: one EventSource per page while the API will
   answer it. EventSource reconnects on its own after a dropped
   connection, but an HTTP error (a 401 before sign-in) is fatal to it —
   so the stream starts only once the browser is signed in (or Login is
   off), stops on sign-out, and a stream the server closed is reopened
   with a backoff. nginx has proxy_buffering off for /api/scan so events
   arrive unbuffered. */

import { invalidateLibrary, queryClient } from "./queryClient";
import { api } from "./client";
import { statusFromEvent, useScanStore } from "../stores/scan";

let source: EventSource | null = null;
let wanted = false;
let retryTimer: number | null = null;
let retryDelayMs = 2000;
const MAX_RETRY_DELAY_MS = 60_000;

function seedFromSettings(): void {
  // Seed from the REST snapshot, then let the stream take over. Also the
  // catch-up after a reconnect: events missed while closed are gone.
  void api.GET("/api/settings").then(({ data }) => {
    if (data) {
      useScanStore.getState().setStatus({
        state: data.scan.state,
        phase: data.scan.phase,
        current: data.scan.current,
        total: data.scan.total,
        errors: data.scan.errors,
        finishedAt: data.scan.finished_at,
        mountGuard: data.scan.mount_guard,
      });
    }
  });
}

function open(): void {
  if (source != null || !wanted) return;
  seedFromSettings();
  const stream = new EventSource("/api/scan");
  source = stream;
  stream.onopen = () => {
    retryDelayMs = 2000;
  };
  stream.onerror = () => {
    // CONNECTING: the browser is already retrying a dropped connection.
    // CLOSED: the server refused (401, 5xx) — reopen later ourselves.
    if (stream.readyState !== EventSource.CLOSED || source !== stream) return;
    source = null;
    if (!wanted || retryTimer != null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      open();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  };
  stream.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data as string) as {
        type: "state";
        state: "idle" | "scanning";
        phase: "scan" | "watch" | "analyze" | null;
        current: number;
        total: number;
        errors: number;
        finished_at: string | null;
        mount_guard?: boolean;
      };
      const previous = useScanStore.getState().status;
      useScanStore.getState().setStatus(statusFromEvent(event));
      // A scan that just finished changed the library under every list:
      // counts, grids, Recently added, search. Only the transition — the
      // stream's first idle event on connect changes nothing. The index is
      // final once the loudness pass starts (the scan stays "scanning"
      // through it), so new songs show up then, not after the analysis.
      const indexed =
        event.state === "idle" ||
        (event.phase === "analyze" && previous?.phase !== "analyze");
      if (indexed && previous?.state === "scanning") {
        invalidateLibrary(queryClient);
      }
    } catch {
      // Malformed event: ignore, keep last known state.
    }
  };
}

/** Start (or keep) the stream. Call once the API will answer it: signed
    in, or Login off. Idempotent. */
export function ensureScanSync(): void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return;
  wanted = true;
  open();
}

/** Close the stream (signed out): a refused stream would only retry
    against a 401 until sign-in starts it again. */
export function stopScanSync(): void {
  wanted = false;
  if (retryTimer != null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  source?.close();
  source = null;
  retryDelayMs = 2000;
}
