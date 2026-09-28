import { useEffect } from "react";
import { Outlet } from "react-router";

import { ensureScanSync } from "../api/scanSync";
import { PlayerBar } from "./PlayerBar";
import { Sidebar } from "./Sidebar";
import { useUiStore } from "../stores/ui";
import "../styles/shell.css";

export function AppShell() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  useEffect(() => {
    ensureScanSync();
  }, []);

  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}`}>
      <Sidebar />
      <div className="shell__main">
        <main className="shell__canvas">
          <Outlet />
        </main>
        <PlayerBar />
      </div>
    </div>
  );
}
