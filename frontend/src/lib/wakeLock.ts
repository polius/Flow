/* Keep the screen on while a song plays — a per-device setting, off by
   default (Settings → Playback). Music keeps playing with the screen off
   either way; this only stops the phone dimming and locking while Flow is
   on screen and playing.

   The Screen Wake Lock API: the browser drops the lock whenever the page
   is hidden (another app, the tab switched, the phone locked by hand), so
   it is asked for again each time the page comes back while a song still
   plays. Pausing, or turning the setting off, lets it go. Where the API is
   missing the setting is not offered. */

import { useEffect } from "react";

import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

export const wakeLockSupported: boolean =
  typeof navigator !== "undefined" && "wakeLock" in navigator;

export function useKeepScreenOn(): void {
  const keepAwake = useUiStore((s) => s.keepAwake);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const active = keepAwake && isPlaying;

  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released))
        return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) void next.release();
        else lock = next;
      } catch {
        // Refused (battery saver, a page without focus): the phone just
        // dims as usual; the next return to the page asks again.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (lock && !lock.released) void lock.release();
    };
  }, [active]);
}
