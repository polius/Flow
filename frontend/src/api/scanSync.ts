/* Live scan-status sync: one EventSource per page, forever.
   EventSource reconnects on its own; nginx has proxy_buffering off for
   /api/scan so events arrive unbuffered (DESIGN.md §10). */

import { queryClient } from "./queryClient";
import { api } from "./client";
import { statusFromEvent, useScanStore } from "../stores/scan";

let started = false;

export function ensureScanSync(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  // Seed from the REST snapshot, then let the stream take over.
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

  const source = new EventSource("/api/scan");
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as {
        type: "state";
        state: "idle" | "scanning";
        phase: "scan" | "watch" | "analyze" | null;
        current: number;
        total: number;
        errors: number;
        finished_at: string | null;
        mount_guard?: boolean;
      };
      useScanStore.getState().setStatus(statusFromEvent(event));
      // Counts and settings-derived UI refresh when a scan completes.
      if (event.state === "idle") {
        void queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
    } catch {
      // Malformed event: ignore, keep last known state.
    }
  };
}
