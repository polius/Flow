/* TopBar — the full-width chrome bar (§9.1). The sidebar was retired with
   the owner's approval: with a fixed, small set of sections, icon-only nav
   lives here and the canvas gets the whole window (§18).
   Zones: brand · scan status · search · section nav. On phones (§19) the
   section nav collapses into an overflow button + pull-down sheet.

   Search (§9.2 revision): typing NEVER navigates. Results drop from the
   field as a Spotlight-style panel, in place — the user keeps their
   context; their eyes stay where their hands are. The /search route
   survives as the explicit "See all results" destination (the panel's
   footer), not as a redirect. */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { fmtCount, scanProgressLabel } from "../lib/format";
import { useScanStore } from "../stores/scan";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import { PlaylistArt } from "./PlaylistArt";
import {
  IconAlbums,
  IconArtists,
  IconClose,
  IconHeart,
  IconMenu,
  IconMusicNote,
  IconPlay,
  IconPlaylists,
  IconSearch,
  IconSettings,
  IconTracks,
  type IconProps,
} from "./icons";
import "../styles/topbar.css";

const DEBOUNCE_MS = 200;

interface NavEntry {
  to: string;
  label: string;
  Icon: (props: IconProps) => ReturnType<typeof IconMusicNote>;
}

/* Section nav — the brand lockup is the Home affordance (§18), so "/" is
   not repeated here. Listening sections only, ordered by the owner's
   frequency of use (§23): Tracks, Albums, Artists, Favorites, Playlists.
   Organize lives behind Tracks' header button (a task, not a section).
   Settings is kept apart from the library sections, mirroring the hairline
   break in both nav forms. */
const NAV: NavEntry[] = [
  { to: "/tracks", label: "Tracks", Icon: IconTracks },
  { to: "/albums", label: "Albums", Icon: IconAlbums },
  { to: "/artists", label: "Artists", Icon: IconArtists },
  { to: "/favorites", label: "Favorites", Icon: IconHeart },
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

  // On /search the field edits THAT page's query, live (deep-link state).
  // Everywhere else typing stays put: the spotlight panel below the field
  // carries the results — no section change mid-sentence.
  useEffect(() => {
    if (pathname !== "/search") return;
    const handle = setTimeout(() => {
      const next = text.trim();
      if (next === urlQuery) return;
      setSearchParams(next ? { q: next } : {}, { replace: true });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text, urlQuery, pathname, setSearchParams]);

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

      <SearchZone
        text={text}
        setText={setText}
        inputRef={inputRef}
        onKeyDown={onKeyDown}
        navigate={navigate}
      />

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

/* ---- spotlight search -----------------------------------------------------
   The field plus its drop panel, as one zone. The panel is deliberately
   position-anchored chrome (not a route): results appear under the user's
   hands while the page behind never changes. */

interface SuggestItem {
  key: string;
  render: () => React.ReactNode;
  activate: () => void;
}

function SearchZone({
  text,
  setText,
  inputRef,
  onKeyDown,
  navigate,
}: {
  text: string;
  setText: (t: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  navigate: (to: string) => void;
}) {
  const { pathname } = useLocation();
  const q = text.trim();
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const zoneRef = useRef<HTMLDivElement>(null);

  const search = useQuery({
    queryKey: ["search", q],
    queryFn: async () => {
      const { data } = await api.GET("/api/search", {
        params: { query: { q } },
      });
      return data;
    },
    // On /search the page below IS the results — the panel stays shut.
    enabled: q.length > 0 && open && pathname !== "/search",
    placeholderData: (prev) => prev,
  });

  const results = q.length > 0 ? search.data : undefined;

  const playTracks = usePlayerStore((s) => s.playTracks);

  const go = (to: string) => {
    setOpen(false);
    inputRef.current?.blur();
    navigate(to);
  };

  const items = useMemo<SuggestItem[]>(() => {
    if (!results) return [];
    const list: SuggestItem[] = [];
    results.tracks.slice(0, 4).forEach((t, i) => {
      list.push({
        key: `t-${t.id}`,
        render: () => (
          <>
            <Artwork artworkId={t.artwork_id} size={28} radius="s" />
            <span className="suggest__name">{t.title}</span>
            <span className="suggest__meta">{t.artist ?? " "}</span>
          </>
        ),
        activate: () => {
          setOpen(false);
          inputRef.current?.blur();
          playTracks(results.tracks, i);
        },
      });
    });
    results.albums.slice(0, 4).forEach((a) => {
      list.push({
        key: `a-${a.id}`,
        render: () => (
          <>
            <Artwork artworkId={a.artwork_id} size={28} radius="s" />
            <span className="suggest__name">{a.title}</span>
            <span className="suggest__meta">{a.artist ?? " "}</span>
          </>
        ),
        activate: () => go(`/albums/${a.id}`),
      });
    });
    results.artists.slice(0, 3).forEach((a) => {
      list.push({
        key: `r-${a.id}`,
        render: () => (
          <>
            <span className="suggest__avatar" aria-hidden="true">
              <Artwork artworkId={a.artwork_id} size={28} radius="s" />
            </span>
            <span className="suggest__name">{a.name}</span>
            <span className="suggest__meta">Artist</span>
          </>
        ),
        activate: () => go(`/artists/${a.id}`),
      });
    });
    results.playlists.slice(0, 3).forEach((p) => {
      list.push({
        key: `p-${p.id}`,
        render: () => (
          <>
            <PlaylistArt
              artworkIds={p.artwork_ids}
              coverArtworkId={p.cover_artwork_id}
              size={28}
              radius="s"
            />
            <span className="suggest__name">{p.name}</span>
            <span className="suggest__meta">
              {fmtCount(p.track_count)} track{p.track_count === 1 ? "" : "s"}
            </span>
          </>
        ),
        activate: () => go(`/playlists/${p.id}`),
      });
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  // Groups are views over the flat list, so keyboard order == visual order.
  const groups = useMemo(() => {
    if (items.length === 0) return [];
    const spans: { label: string; count: number }[] = [
      { label: "Tracks", count: Math.min(4, results?.tracks.length ?? 0) },
      { label: "Albums", count: Math.min(4, results?.albums.length ?? 0) },
      { label: "Artists", count: Math.min(3, results?.artists.length ?? 0) },
      { label: "Playlists", count: Math.min(3, results?.playlists.length ?? 0) },
    ];
    let cursor = 0;
    return spans
      .filter((s) => s.count > 0)
      .map((s) => {
        const from = cursor;
        cursor += s.count;
        return { label: s.label, from, count: s.count };
      });
  }, [items, results]);

  useEffect(() => setActiveIdx(-1), [q]);

  // Panel lifecycle: outside tap and route changes close it. Esc is the
  // field's own handler (clears first, blurs second) — the panel simply
  // follows the text.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (zoneRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const panelOpen = open && q.length > 0 && pathname !== "/search";

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (panelOpen && results) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(items.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(-1, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) {
          items[activeIdx].activate();
          return;
        }
        // No highlight: Enter means "everything", the /search page.
        go(`/search?q=${encodeURIComponent(q)}`);
        return;
      }
    }
    onKeyDown(e);
  };

  return (
    <div className="topbar__searchzone" ref={zoneRef}>
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
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim()) setOpen(true);
          }}
          onFocus={() => {
            if (text.trim()) setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
        />
      </div>

      {panelOpen && (
        <div className="suggest" role="listbox" aria-label="Search results">
          {search.isFetching && !results ? (
            <div className="suggest__loading">Searching…</div>
          ) : results && items.length === 0 ? (
            <div className="suggest__loading">No results for “{q}”</div>
          ) : results ? (
            <>
              {groups.map((g) => (
                <div key={g.label} className="suggest__group">
                  <span className="suggest__grouplabel">{g.label}</span>
                  {items
                    .slice(g.from, g.from + g.count)
                    .map((item, i) => {
                      const idx = g.from + i;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          role="option"
                          aria-selected={activeIdx === idx}
                          className={`suggest__item${
                            activeIdx === idx ? " suggest__item--active" : ""
                          }`}
                          onMouseEnter={() => setActiveIdx(idx)}
                          onClick={item.activate}
                        >
                          {item.render()}
                          <span className="suggest__play" aria-hidden="true">
                            <IconPlay size={11} />
                          </span>
                        </button>
                      );
                    })}
                </div>
              ))}
              <button
                type="button"
                className={`suggest__all${
                  activeIdx === -1 ? " suggest__all--active" : ""
                }`}
                onClick={() => go(`/search?q=${encodeURIComponent(q)}`)}
              >
                See all results for “{q}”
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
