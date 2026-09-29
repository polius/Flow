import { useEffect, useLayoutEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";

import { ensureScanSync } from "../api/scanSync";
import { useGlobalShortcuts } from "../lib/shortcuts";
import { GetInfoPanel } from "./GetInfoPanel";
import { NowPlaying } from "./NowPlaying";
import { PlayerBar } from "./PlayerBar";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useUiStore } from "../stores/ui";
import "../styles/shell.css";

export function AppShell() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const focusSearch = useUiStore((s) => s.focusSearch);
  const location = useLocation();
  const canvasRef = useRef<HTMLElement>(null);
  useGlobalShortcuts();

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

  // ⌘F / Ctrl+F focuses the top-bar search field from anywhere (§9.5).
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

  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}`}>
      <Sidebar />
      <div className="shell__main">
        <TopBar />
        <main ref={canvasRef} className="shell__canvas">
          <Outlet />
        </main>
        <PlayerBar />
      </div>
      <GetInfoPanel />
      <NowPlaying />
    </div>
  );
}
