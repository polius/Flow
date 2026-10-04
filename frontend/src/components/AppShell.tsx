import { useEffect, useLayoutEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "react-router";

import { useAuthStatus } from "../api/auth";
import { ensureScanSync } from "../api/scanSync";
import { useGlobalShortcuts } from "../lib/shortcuts";
import { AddToPlaylistDialog } from "./AddToPlaylistDialog";
import { GetInfoPanel } from "./GetInfoPanel";
import { NowPlaying } from "./NowPlaying";
import { OrganizeSheet } from "./OrganizeSheet";
import { PlayerBar } from "./PlayerBar";
import { TopBar } from "./TopBar";
import { TrackActionsMenu } from "./TrackActionsMenu";
import { UndoToast } from "./UndoToast";
import { useUiStore } from "../stores/ui";
import "../styles/shell.css";

export function AppShell() {
  const focusSearch = useUiStore((s) => s.focusSearch);
  const location = useLocation();
  const canvasRef = useRef<HTMLElement>(null);
  useGlobalShortcuts();

  const { data: authStatus } = useAuthStatus();

  useEffect(() => {
    ensureScanSync();
  }, []);

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
      <GetInfoPanel />
      <TrackActionsMenu />
      <AddToPlaylistDialog />
      <UndoToast />
      <OrganizeSheet />
      <NowPlaying />
    </div>
  );
}
