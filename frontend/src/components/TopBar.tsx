/* TopBar — the full-width chrome bar (§9.1). The sidebar was retired with
   the owner's approval: with a fixed, small set of sections, icon-only nav
   lives here and the canvas gets the whole window (§18).
   Zones: brand · scan status · search · section nav.
   The search field is still the single search input: typing navigates to
   /search?q=… (debounced ~200 ms) so the query lives in the URL (§9.2). */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";

import {
  IconAlbums,
  IconArtists,
  IconMusicNote,
  IconPlaylists,
  IconSearch,
  IconSettings,
  IconTracks,
  type IconProps,
} from "./icons";
import { fmtCount, scanProgressLabel } from "../lib/format";
import { useScanStore } from "../stores/scan";
import { useUiStore } from "../stores/ui";
import "../styles/topbar.css";

const DEBOUNCE_MS = 200;

interface NavEntry {
  to: string;
  label: string;
  Icon: (props: IconProps) => ReturnType<typeof IconMusicNote>;
}

/* Section nav — the brand lockup is the Home affordance (§18), so "/" is
   not repeated here. */
const NAV: NavEntry[] = [
  { to: "/albums", label: "Albums", Icon: IconAlbums },
  { to: "/artists", label: "Artists", Icon: IconArtists },
  { to: "/tracks", label: "Tracks", Icon: IconTracks },
  { to: "/playlists", label: "Playlists", Icon: IconPlaylists },
];

export function TopBar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [text, setText] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusSignal = useUiStore((s) => s.searchFocusSignal);
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";
  // ⌘F skips the mount run (StrictMode re-runs effects), which would steal
  // focus on page load.
  const initialSignal = useRef(focusSignal);

  // ⌘F / Ctrl+F from anywhere focuses this field (§9.5).
  useEffect(() => {
    if (focusSignal === initialSignal.current) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  // External navigation (Back/Forward, deep links) updates the field.
  useEffect(() => {
    setText(urlQuery);
  }, [urlQuery]);

  // Debounce typing into the URL (the query key). The effect re-runs on any
  // route change, cancelling a pending write — navigating away mid-type must
  // not yank the user into /search.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = text.trim();
      if (next === urlQuery) return; // already reflected in the URL
      if (pathname === "/search") {
        setSearchParams(next ? { q: next } : {}, { replace: true });
      } else if (next) {
        navigate(`/search?q=${encodeURIComponent(next)}`);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text, urlQuery, pathname, navigate, setSearchParams]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && text) {
      e.stopPropagation();
      setText("");
      inputRef.current?.blur();
    }
  };

  const scanLabel = scan
    ? scan.phase === "watch"
      ? "Updating…"
      : scanProgressLabel(scan.current, scan.total)
    : null;

  return (
    <header className="topbar">
      <NavLink to="/" end className="topbar__brand" title="Home">
        <span className="topbar__brand-mark">
          <IconMusicNote size={15} />
        </span>
        <span className="topbar__brand-name">Flow</span>
      </NavLink>

      {/* Global scan indicator — inherited from the retired sidebar (§9.6).
          Quiet, tabular, honest; gone the moment the scan settles. */}
      {scanning && scan && scanLabel && (
        <div className="topbar__scan" role="status" aria-live="polite">
          <span className="topbar__scan-spin" aria-hidden="true" />
          <span className="topbar__scan-text">
            {scanLabel}
            {scan.errors > 0 ? ` · ${fmtCount(scan.errors)} errors` : ""}
          </span>
        </div>
      )}

      <div className="topbar__search">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          className="topbar__input"
          type="search"
          name="q"
          placeholder="Albums, artists, tracks, playlists…"
          value={text}
          aria-label="Search library"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <nav className="topbar__nav" aria-label="Library">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `topbar__nav-item${isActive ? " topbar__nav-item--active" : ""}`
            }
            aria-label={label}
            title={label}
          >
            <Icon size={18} />
          </NavLink>
        ))}
        <span className="topbar__nav-sep" aria-hidden="true" />
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `topbar__nav-item${isActive ? " topbar__nav-item--active" : ""}`
          }
          aria-label="Settings"
          title="Settings"
        >
          <IconSettings size={18} />
        </NavLink>
      </nav>
    </header>
  );
}
