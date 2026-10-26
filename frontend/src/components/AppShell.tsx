import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";

import { useAuthStatus } from "../api/auth";
import { ensureScanSync, stopScanSync } from "../api/scanSync";
import { useGlobalShortcuts } from "../lib/shortcuts";
import { AddToPlaylistDialog } from "./AddToPlaylistDialog";
import { NowPlaying } from "./NowPlaying";
import { PlayerBar } from "./PlayerBar";
import { TopBar } from "./TopBar";
import { TrackActionsMenu } from "./TrackActionsMenu";
import { UndoToast } from "./UndoToast";
import { resumeServerAdoption } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/shell.css";

/* Organize and Get Info are tasks most visits never open: their code (and
   Organize's stylesheet) loads on first open, then stays mounted exactly
   as before. */
const OrganizeSheet = lazy(() =>
  import("./OrganizeSheet").then((m) => ({ default: m.OrganizeSheet })),
);
const GetInfoPanel = lazy(() =>
  import("./GetInfoPanel").then((m) => ({ default: m.GetInfoPanel })),
);

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

  // The canvas is one shared scroll container across views, so an offset from
  // one section would leak into the next — the new view could land mid-list
  // (or pinned past its content) on first open. Reset synchronously before
  // paint (useLayoutEffect) so the leaked offset is never visible. Search-term
  // updates keep their scroll: only the pathname is reset.
  useLayoutEffect(() => {
    canvasRef.current?.scrollTo(0, 0);
  }, [location.pathname]);

  // ⌘F / Ctrl+F focuses the top-bar search field from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
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
      <div className="shell__main">
        <TopBar />
        <main ref={canvasRef} className="shell__canvas">
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
      <AddToPlaylistDialog />
      <UndoToast />
      {organizeMounted && (
        <Suspense fallback={null}>
          <OrganizeSheet />
        </Suspense>
      )}
      <NowPlaying />
    </div>
  );
}
