/* Is the server there, and is it still running the build this page was
   loaded from? One small watcher answers both for the shell's notice.

   - Reachable: /api/health answers 2xx. A network error or a 5xx (a
     reverse proxy's "bad gateway" while the container restarts) is "down".
     While down it asks every few seconds, so the notice leaves as soon as
     the server is back, and everything the outage left empty refetches.
   - Updated: index.html names the build's entry script by its hashed file
     name. When the server's index.html names another one, this tab runs
     old code against a new server: offer a reload. Checked when the page
     is shown again and every few minutes. */

import { create } from "zustand";

import { queryClient } from "../api/queryClient";

export const UP_INTERVAL_MS = 5 * 60_000;
export const DOWN_INTERVAL_MS = 5_000;
/** A server that does not answer in this long counts as away (a hung
    server must not hold the check, and the notice, forever). */
export const CHECK_TIMEOUT_MS = 5_000;
/** A request loading longer than this asks whether the server is there. */
export const SLOW_MS = 6_000;

function timeout(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  return controller.signal;
}

interface ServerState {
  down: boolean;
  updated: boolean;
}

export const useServerStore = create<ServerState>(() => ({ down: false, updated: false }));

/** The entry script this page was built with, as index.html names it. */
export function entryOf(html: string): string | null {
  const m = /<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html);
  return m?.[1] ?? null;
}

function loadedEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return el?.getAttribute("src") ?? null;
}

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: timeout() });
    return res.ok;
  } catch {
    return false;
  }
}

async function serverEntry(): Promise<string | null> {
  try {
    const res = await fetch("/", { cache: "no-store", signal: timeout() });
    if (!res.ok) return null;
    return entryOf(await res.text());
  } catch {
    return null;
  }
}

let timer: number | undefined;
let checking = false;

/** One check now; schedules the next. Safe to call often. */
export async function checkServer(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const wasDown = useServerStore.getState().down;
    const up = await reachable();
    useServerStore.setState({ down: !up });
    if (up && wasDown) {
      // Back: refill what the outage left empty or failed.
      void queryClient.invalidateQueries();
    }
    if (up && !useServerStore.getState().updated) {
      const mine = loadedEntry();
      const theirs = await serverEntry();
      if (mine && theirs && mine !== theirs) useServerStore.setState({ updated: true });
    }
  } finally {
    checking = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(
      () => void checkServer(),
      useServerStore.getState().down ? DOWN_INTERVAL_MS : UP_INTERVAL_MS,
    );
  }
}

/** Start watching; returns the stop function. A failed query (the network
    threw) and the browser's own offline/online events ask at once. */
export function watchServer(): () => void {
  const now = () => void checkServer();
  const onVisible = () => {
    if (document.visibilityState === "visible") now();
  };
  // A request still loading after a few seconds is the sign of a server
  // that hangs (a sleeping NAS) rather than one that refuses: ask then.
  let slow: number | undefined;
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    if (event.action.type === "error") now();
    if (event.action.type === "fetch") {
      window.clearTimeout(slow);
      slow = window.setTimeout(() => {
        if (queryClient.isFetching() > 0) now();
      }, SLOW_MS);
    }
  });
  window.addEventListener("online", now);
  window.addEventListener("offline", now);
  window.addEventListener("focus", now);
  document.addEventListener("visibilitychange", onVisible);
  now();
  return () => {
    unsubscribe();
    window.removeEventListener("online", now);
    window.removeEventListener("offline", now);
    window.removeEventListener("focus", now);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearTimeout(timer);
    window.clearTimeout(slow);
  };
}
