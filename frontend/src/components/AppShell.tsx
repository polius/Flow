import { Outlet } from "react-router";

import { PlayerBar } from "./PlayerBar";
import { Sidebar } from "./Sidebar";
import { useUiStore } from "../stores/ui";
import "../styles/shell.css";

export function AppShell() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

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
