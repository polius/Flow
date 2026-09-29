import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";

import { ensureScanSync } from "../api/scanSync";
import { GetInfoPanel } from "./GetInfoPanel";
import { PlayerBar } from "./PlayerBar";
import { Sidebar } from "./Sidebar";
import { useUiStore } from "../stores/ui";
import "../styles/shell.css";

export function AppShell() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const focusSearch = useUiStore((s) => s.focusSearch);
  const navigate = useNavigate();

  useEffect(() => {
    ensureScanSync();
  }, []);

  // ⌘F / Ctrl+F focuses search from anywhere (§9.5).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        navigate("/search");
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, focusSearch]);

  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}`}>
      <Sidebar />
      <div className="shell__main">
        <main className="shell__canvas">
          <Outlet />
        </main>
        <PlayerBar />
      </div>
      <GetInfoPanel />
    </div>
  );
}
