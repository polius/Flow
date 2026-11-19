import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, NavigationType, Outlet, useLocation, useNavigationType } from "react-router";

import { useAuthStatus } from "../api/auth";
import { ensureScanSync, stopScanSync } from "../api/scanSync";
import { lazyPart } from "../lib/lazyParts";
import { useGlobalShortcuts } from "../lib/shortcuts";
import { Announcer } from "./Announcer";
import { PlayerBar } from "./PlayerBar";
import { ServerNotice } from "./ServerNotice";
import { ShortcutSheet } from "./ShortcutSheet";
import { TopBar } from "./TopBar";
import { TrackActionsMenu } from "./TrackActionsMenu";
import { UndoToast } from "./UndoToast";
import { endPlayback, resumeServerAdoption } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/shell.css";

/* Surfaces that render nothing until opened load their code on first
   open, then stay mounted exactly as before: Organize, Get Info, Now
   Playing (with the queue) and Add to Playlist. Most visits never open
   Organize or Get Info, and none needs Now Playing to show the library. */
const OrganizeSheet = lazyPart(() => import("./OrganizeSheet"), (m) => m.OrganizeSheet);
const GetInfoPanel = lazyPart(() => import("./GetInfoPanel"), (m) => m.GetInfoPanel);
const NowPlaying = lazyPart(() => import("./NowPlaying"), (m) => m.NowPlaying);
const AddToPlaylistDialog = lazyPart(() => import("./AddToPlaylistDialog"), (m) => m.AddToPlaylistDialog);

/** True from the first time `flag` is true: a lazy surface mounts on
    first open and is never torn down again. */
function useOpenedOnce(flag: boolean): boolean {
  const [opened, setOpened] = useState(flag);
  if (flag && !opened) setOpened(true);
  return opened || flag;
}

export function AppShell() {
  const focusSearch = useUiStore((s) => s.focusSearch);
  const location = useLocation();
  const canvasRef = useRef<HTMLElement>(null);
  useGlobalShortcuts();

  const { data: authStatus } = useAuthStatus();
  const organizeMounted = useOpenedOnce(useUiStore((s) => s.organizeOpen));
  const getInfoMounted = useOpenedOnce(useUiStore((s) => s.getInfoTrackId != null));
  const nowPlayingMounted = useOpenedOnce(useUiStore((s) => s.nowPlayingOpen));
  const addToPlaylistMounted = useOpenedOnce(useUiStore((s) => s.addToPlaylistTarget != null));

  // The API answers only a signed-in browser (or anyone, with Login off):
  // the scan stream and the server-queue adoption wait for that. Opened
  // before sign-in, the stream died on its 401 for good, and the queue
  // adoption gave up.
  const apiOpen =
    authStatus != null && (!authStatus.enabled || authStatus.authenticated);
  useEffect(() => {
    if (!apiOpen) {
      stopScanSync();
      return;
    }
    ensureScanSync();
    resumeServerAdoption();
  }, [apiOpen]);
  // The session ended under a playing song (it expired, or was closed from
  // elsewhere): the sound stops with it. The queue stays for the sign-in
  // that follows; an explicit sign-out clears it (AccessSettings).
  const signedOut = authStatus != null && authStatus.enabled && !authStatus.authenticated;
  useEffect(() => {
    if (signedOut) endPlayback({ forget: false });
  }, [signedOut]);

  // The canvas is one shared scroll container across views, so an offset from
  // one section would leak into the next — the new view could land mid-list
  // (or pinned past its content) on first open. A new page starts at the
  // top; going Back or Forward returns to where that page was left (a long
  // grid would otherwise restart from its first row every time an album
  // was opened from it). Set synchronously before paint (useLayoutEffect)
  // so the leaked offset is never visible. Search-term updates keep their
  // scroll: only a pathname change moves it.
  const navigationType = useNavigationType();
  const scrollByEntry = useRef(new Map<string, number>());
  const shownKey = useRef(location.key);
  const lastScroll = useRef(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onScroll = () => {
      lastScroll.current = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    // Leaving: remember where the entry that was on screen had got to.
    if (shownKey.current !== location.key)
      scrollByEntry.current.set(shownKey.current, lastScroll.current);
    const back = navigationType === NavigationType.Pop;
    const saved = back ? (scrollByEntry.current.get(location.key) ?? 0) : 0;
    let frame = 0;
    let tries = 0;
    // The page may still be laying out (a windowed grid measures itself
    // first): keep asking until the canvas is tall enough, for a moment.
    const restore = () => {
      el.scrollTo(0, saved);
      lastScroll.current = el.scrollTop;
      if (Math.abs(el.scrollTop - saved) > 1 && tries++ < 30)
        frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);
  useEffect(() => {
    shownKey.current = location.key;
  });

  // ⌘F / Ctrl+F focuses the top-bar search field from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        // Pressed again from the search field itself, the key goes to
        // the browser: its own find-in-page is one more press away.
        if (document.activeElement?.closest?.(".topbar__search") != null) return;
        e.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSearch]);

  // The login guard: when the owner turned Login on, an unauthenticated
  // browser gets no further. The API is already refusing it (401s flip the
  // cached status via the client middleware), so this redirect lands the
  // moment the status is known — and hands /login the destination so
  // sign-in returns the user exactly where they were heading.
  if (authStatus?.enabled && !authStatus.authenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  return (
    <div className="shell">
      {/* The first two Tab stops, shown only when focused: past the top
          bar to the page, or past the page to the player. */}
      <a
        href="#content"
        className="skiplink"
        onClick={(e) => {
          e.preventDefault();
          canvasRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <a
        href="#player"
        className="skiplink"
        onClick={(e) => {
          e.preventDefault();
          document
            .querySelector<HTMLElement>(".player button:not(:disabled), .player a[href]")
            ?.focus();
        }}
      >
        Skip to player
      </a>
      <div className="shell__main">
        <TopBar />
        <main ref={canvasRef} id="content" tabIndex={-1} className="shell__canvas">
          <Outlet />
        </main>
        <PlayerBar />
      </div>
      {getInfoMounted && (
        <Suspense fallback={null}>
          <GetInfoPanel />
        </Suspense>
      )}
      <TrackActionsMenu />
      {addToPlaylistMounted && (
        <Suspense fallback={null}>
          <AddToPlaylistDialog />
        </Suspense>
      )}
      <UndoToast />
      <ServerNotice />
      <Announcer />
      <ShortcutSheet />
      {organizeMounted && (
        <Suspense fallback={null}>
          <OrganizeSheet />
        </Suspense>
      )}
      {nowPlayingMounted && (
        <Suspense fallback={null}>
          <NowPlaying />
        </Suspense>
      )}
    </div>
  );
}
