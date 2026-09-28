/* Sidebar — icon + label, collapsible (DESIGN.md §9.1).
   The library scan status row lands here with the scanner (Milestone 2). */

import { NavLink } from "react-router";

import {
  IconAlbums,
  IconArtists,
  IconHome,
  IconMusicNote,
  IconPanel,
  IconPlaylists,
  IconSettings,
  IconTracks,
  type IconProps,
} from "./icons";
import { scanProgressLabel } from "../lib/format";
import { useScanStore } from "../stores/scan";
import { useUiStore } from "../stores/ui";
import "../styles/sidebar.css";

interface NavEntry {
  to: string;
  label: string;
  Icon: (props: IconProps) => ReturnType<typeof IconPanel>;
  end?: boolean;
}

const NAV: NavEntry[] = [
  { to: "/", label: "Home", Icon: IconHome, end: true },
  { to: "/albums", label: "Albums", Icon: IconAlbums },
  { to: "/artists", label: "Artists", Icon: IconArtists },
  { to: "/tracks", label: "Tracks", Icon: IconTracks },
  { to: "/playlists", label: "Playlists", Icon: IconPlaylists },
];

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";

  const itemClass = ({ isActive }: { isActive: boolean }) =>
    `sidebar__item${isActive ? " sidebar__item--active" : ""}`;

  return (
    <nav
      className="sidebar"
      aria-label="Library"
    >
      <div className="sidebar__top">
        <NavLink to="/" end className="sidebar__brand" title="Flow">
          <span className="sidebar__brand-mark">
            <IconMusicNote size={15} />
          </span>
          <span className="sidebar__label">Flow</span>
        </NavLink>
        <button
          type="button"
          className="sidebar__toggle"
          onClick={toggleSidebar}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
        >
          <IconPanel size={16} />
        </button>
      </div>

      <ul className="sidebar__nav">
        {NAV.map(({ to, label, Icon, end }) => (
          <li key={to}>
            <NavLink to={to} end={end} className={itemClass} title={label}>
              <Icon size={17} />
              <span className="sidebar__label">{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      {scanning && scan && (
        <div
          className="sidebar__scanstatus"
          title={scan.phase === "watch" ? "Library changed — updating" : "Library scan in progress"}
        >
          {scanProgressLabel(scan.current, scan.total)}
        </div>
      )}

      <ul className="sidebar__nav sidebar__nav--footer">
        <li>
          <NavLink to="/settings" className={itemClass} title="Settings">
            <IconSettings size={17} />
            <span className="sidebar__label">Settings</span>
          </NavLink>
        </li>
      </ul>
    </nav>
  );
}
