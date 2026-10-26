/* The one screen-reader announcer. Live regions that mount on demand are
   unreliable — VoiceOver often misses a region that appears together with
   its text — and the scan used to speak every progress tick from two places
   at once. Instead the shell keeps ONE visually hidden polite region
   mounted for the app's whole life, and everything that wants to be heard
   goes through `announce()`.

   What speaks: undo/notice toasts (as they appear), and the library scan —
   at its start, at its end, and when it ends with skipped files. Progress
   ticks never do. */

import { useEffect, useRef } from "react";

import { announce, scanAnnouncement, useAnnouncer } from "../lib/announce";
import { useScanStore } from "../stores/scan";
import { useUiStore } from "../stores/ui";

export function Announcer() {
  const message = useAnnouncer((s) => s.message);
  const nonce = useAnnouncer((s) => s.nonce);

  // Scan: only the edges speak. The first status seen (page load) is a
  // baseline, not news — a scan already running on load says nothing
  // until it ends.
  const lastScanState = useRef<"idle" | "scanning" | null | undefined>(undefined);
  useEffect(() => {
    lastScanState.current = useScanStore.getState().status?.state;
    return useScanStore.subscribe((s) => {
      const status = s.status;
      if (!status) return;
      const prev = lastScanState.current;
      lastScanState.current = status.state;
      if (prev === undefined) return;
      const line = scanAnnouncement(prev, status.state, status.errors);
      if (line) announce(line);
    });
  }, []);

  // Notices: the toast is visual; its sentence is spoken here.
  useEffect(
    () =>
      useUiStore.subscribe((s, prev) => {
        const notice = s.undoNotice;
        if (!notice || notice.id === prev.undoNotice?.id) return;
        announce(notice.undo ? `${notice.message} Undo is available.` : notice.message);
      }),
    [],
  );

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {/* Keyed by nonce: a repeated sentence re-mounts its text node, which
          screen readers read again. */}
      <span key={nonce}>{message}</span>
    </div>
  );
}
