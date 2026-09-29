import { useEffect } from "react";
import { Outlet } from "react-router";

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
  useGlobalShortcuts();

  useEffect(() => {
    ensureScanSync();
  }, []);

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
        <main className="shell__canvas">
          <Outlet />
        </main>
        <PlayerBar />
      </div>
      <GetInfoPanel />
      <NowPlaying />
    </div>
  );
}
