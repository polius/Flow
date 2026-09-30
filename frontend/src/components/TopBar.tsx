/* TopBar — the full-width chrome bar (§9.1). The sidebar was retired with
   the owner's approval: with a fixed, small set of sections, icon-only nav
   lives here and the canvas gets the whole window (§18).
   Zones: brand · scan status · search · section nav. On phones (§19) the
   section nav collapses into an overflow button + pull-down sheet.
   The search field is still the single search input: typing navigates to
   /search?q=… (debounced ~200 ms) so the query lives in the URL (§9.2). */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";

import {
  IconAlbums,
  IconArtists,
  IconClose,
  IconMenu,
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
   not repeated here. Listening sections only, ordered by the owner's
   frequency of use (§23): Tracks, Albums, Artists, Playlists — Organize
   lives in the Tracks view's header now. Settings is kept apart from the
   library sections, mirroring the hairline break in both nav forms. */
const NAV: NavEntry[] = [
  { to: "/tracks", label: "Tracks", Icon: IconTracks },
  { to: "/albums", label: "Albums", Icon: IconAlbums },
  { to: "/artists", label: "Artists", Icon: IconArtists },
  { to: "/playlists", label: "Playlists", Icon: IconPlaylists },
];

/* Below the phone breakpoint the icon row collapses into an overflow
   button + pull-down sheet (§19) — see topbar.css. Desktop is untouched. */
const PHONE_BP = "(min-width: 641px)";

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
  const [navOpen, setNavOpen] = useState(false);
  const navBtnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
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

  // The overflow sheet (§19) closes with its context: navigation, outside
  // tap, Esc, or growing back past the phone breakpoint.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    // Registered like any menu: Esc precedence (§15.7, §16.4) and the
    // shortcut guard (§16.3) defer to it while it is up.
    useUiStore.getState().setContextMenuOpen(true);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // Taps inside the sheet are its items; taps on the button fall through
      // to its own toggle — neither closes here, or the toggle double-fires.
      if (sheetRef.current?.contains(t) || navBtnRef.current?.contains(t)) return;
      setNavOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    const mq = window.matchMedia(PHONE_BP);
    const onBreakpoint = () => {
      if (mq.matches) setNavOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    mq.addEventListener("change", onBreakpoint);
    return () => {
      useUiStore.getState().setContextMenuOpen(false);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      mq.removeEventListener("change", onBreakpoint);
    };
  }, [navOpen]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
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

      {/* Desktop: the icon-only row (§18). Phone: collapsed into the
          overflow sheet below (§19) — the CSS swaps the two forms at the
          phone breakpoint. */}
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

      <button
        ref={navBtnRef}
        type="button"
        className={`topbar__nav-item topbar__navmenu-btn${
          navOpen ? " topbar__navmenu-btn--open" : ""
        }`}
        aria-label="Library menu"
        aria-haspopup="menu"
        aria-expanded={navOpen}
        aria-controls="topbar-navsheet"
        title="Library"
        onClick={() => setNavOpen((o) => !o)}
      >
        {navOpen ? <IconClose size={18} /> : <IconMenu size={18} />}
      </button>

      {navOpen && (
        <div
          ref={sheetRef}
          id="topbar-navsheet"
          className="topbar__sheet"
          role="menu"
          aria-label="Library"
        >
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              role="menuitem"
              className={({ isActive }) =>
                `topbar__sheet-item${isActive ? " topbar__sheet-item--active" : ""}`
              }
              onClick={() => setNavOpen(false)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
          <div className="topbar__sheet-sep" role="separator" />
          <NavLink
            to="/settings"
            role="menuitem"
            className={({ isActive }) =>
              `topbar__sheet-item${isActive ? " topbar__sheet-item--active" : ""}`
            }
            onClick={() => setNavOpen(false)}
          >
            <IconSettings size={18} />
            <span>Settings</span>
          </NavLink>
        </div>
      )}
    </header>
  );
}
