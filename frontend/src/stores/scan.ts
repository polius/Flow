/* Scan progress state, mirrored from the server's SSE stream (/api/scan).
   Seeded from GET /api/settings so a fresh page load is correct before
   the first event arrives. */

import { create } from "zustand";

export type ScanPhase = "scan" | "watch" | "analyze" | null;

export interface ScanStatus {
  state: "idle" | "scanning";
  phase: ScanPhase;
  current: number;
  total: number;
  errors: number;
  finishedAt: string | null;
  /** Broken-mount guard tripped on the last scan — Settings shows the
      calm explanation instead of a bare error count. */
  mountGuard: boolean;
}

interface ScanStore {
  status: ScanStatus | null;
  setStatus: (status: ScanStatus) => void;
}

export const useScanStore = create<ScanStore>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));

export function statusFromEvent(event: {
  state: "idle" | "scanning";
  phase: ScanPhase;
  current: number;
  total: number;
  errors: number;
  finished_at: string | null;
  mount_guard?: boolean;
}): ScanStatus {
  return {
    state: event.state,
    phase: event.phase,
    current: event.current,
    total: event.total,
    errors: event.errors,
    finishedAt: event.finished_at,
    mountGuard: event.mount_guard ?? false,
  };
}
