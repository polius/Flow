/* TopBar — the full-width chrome bar. Zones: brand · scan status ·
   search · section nav. The nav has three forms: icon + text labels on
   wide windows, the icon-only row below that, and — on phones — an
   overflow button + pull-down sheet.

   Search: typing NEVER navigates. Results drop from the field as a
   Spotlight-style panel, in place — the user keeps their context; their
   eyes stay where their hands are. The /search route survives as the
   explicit "See all results" destination (the panel's footer), not as a
   redirect. */

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { useDebouncedValue } from "../lib/debounce";
import { lazyPart } from "../lib/lazyParts";
import { fmtCount, scanProgressFraction, scanStatusLabel } from "../lib/format";
import { useMediaQuery } from "../lib/media";
import { MOD_KEY } from "../lib/platform";
import { useScanStore } from "../stores/scan";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import { PlaylistArt } from "./PlaylistArt";
import {
  IconAlbums,
  IconArtists,
  IconFlowMark,
  IconHeart,
  IconHome,
  IconPlay,
  IconPlaylists,
  IconSearch,
  IconSettings,
  IconTracks,
  type IconProps,
} from "./icons";
import "../styles/topbar.css";

const DEBOUNCE_MS = 200;

// The skipped-files list opens from the scan pill: its code loads then.
const ScanErrorsDialog = lazyPart(() => import("./ScanErrors"), (m) => m.ScanErrorsDialog);

interface NavEntry {
  to: string;
  label: string;
  Icon: (props: IconProps) => ReturnType<typeof IconTracks>;
}

/* Section nav. On a desktop the brand lockup is the Home affordance, so
   "/" joins the row only as the phone tab bar's first item (`phone`).
   A tab bar holds five: on a phone Favorites lives in Playlists as its
   pinned first tile, and Settings is the icon in the top bar (`desktop`).
   Organize lives behind the Songs header button (a task, not a section). */
interface NavItem extends NavEntry {
  end?: boolean;
  only?: "phone" | "desktop";
}
const NAV: NavItem[] = [
  { to: "/", label: "Home", Icon: IconHome, end: true, only: "phone" },
  { to: "/tracks", label: "Songs", Icon: IconTracks },
  { to: "/albums", label: "Albums", Icon: IconAlbums },
  { to: "/artists", label: "Artists", Icon: IconArtists },
  { to: "/favorites", label: "Favorites", Icon: IconHeart, only: "desktop" },
  { to: "/playlists", label: "Playlists", Icon: IconPlaylists },
];

/* The breakpoint number mirrors topbar.css — CSS media queries cannot
   read JS constants, so the two must be kept in step (tokens.css documents
   the canonical set). */
const LABELED_BP = "(min-width: 1000px)";

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
  // Wide windows: the section nav wears visible labels. The only JS
  // consumer is the tooltip — a labeled control needs no "Songs" tooltip
  // hovering beside the word "Songs".
  const labeledNav = useMediaQuery(LABELED_BP);
  // The scan pill's error count opens the skipped-files dialog —
  // the count without the list behind it was a dead end.
  const [scanErrorsOpen, setScanErrorsOpen] = useState(false);
  // ⌘F skips the mount run (StrictMode re-runs effects), which would steal
  // focus on page load.
  const initialSignal = useRef(focusSignal);

  // ⌘F / Ctrl+F from anywhere focuses this field.
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

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && text) {
      e.stopPropagation();
      setText("");
      inputRef.current?.blur();
    }
  };

  const scanLabel = scan ? scanStatusLabel(scan) : null;
  // Determinate when the phase counts files: the ring replaces the
  // spinner the moment a total exists, and stays for the loudness pass —
  // "Analyzing audio… 34/1,204" with the arc filling behind the number.
  const scanFraction = scan ? scanProgressFraction(scan) : null;

  return (
    <header className="topbar">
      <NavLink to="/" end className="topbar__brand" title="Home">
        <span className="topbar__brand-mark">
          <IconFlowMark size={24} />
        </span>
        <span className="topbar__brand-name">Flow</span>
      </NavLink>

      {/* Global scan indicator. Quiet, tabular, honest; gone the moment
          the scan settles. The error count is a real control: it opens the
          skipped-files list — a count nobody can inspect is a dead end. */}
      {scanning && scan && scanLabel && (
        // Visual only — progress ticks are not read aloud; the shell's
        // Announcer speaks the scan's start and end.
        <div className="topbar__scan">
          {scanFraction == null ? (
            <span className="topbar__scan-spin" aria-hidden="true" />
          ) : (
            <ScanRing fraction={scanFraction} />
          )}
          <span className="topbar__scan-text">
            {scanLabel}
            {scan.errors > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  className="topbar__scanerrors"
                  onClick={() => setScanErrorsOpen(true)}
                  aria-haspopup="dialog"
                  title="Show the skipped files"
                >
                  {fmtCount(scan.errors)} {scan.errors === 1 ? "error" : "errors"}
                </button>
              </>
            )}
          </span>
        </div>
      )}

      {scanErrorsOpen && (
        <Suspense fallback={null}>
          <ScanErrorsDialog
            onClose={() => setScanErrorsOpen(false)}
            live={scanning}
          />
        </Suspense>
      )}

      <SearchZone
        text={text}
        setText={setText}
        inputRef={inputRef}
        onKeyDown={onKeyDown}
        navigate={navigate}
      />

      {/* Section nav in three forms: labeled on wide windows, the
          icon-only row below that, and on phones a tab bar pinned to the
          bottom of the screen under the mini player — the CSS swaps the
          forms at the breakpoints. */}
      <nav className="topbar__nav" aria-label="Library">
        {NAV.map(({ to, label, Icon, end, only }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `topbar__nav-item topbar__nav-item--labeled${
                only ? ` topbar__nav-item--${only}` : ""
              }${isActive ? " topbar__nav-item--active" : ""}`
            }
            aria-label={label}
            title={labeledNav ? undefined : label}
          >
            <Icon size={18} />
            <span className="topbar__nav-label">{label}</span>
          </NavLink>
        ))}
        <span className="topbar__nav-sep" aria-hidden="true" />
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `topbar__nav-item topbar__nav-item--labeled topbar__nav-item--desktop${
              isActive ? " topbar__nav-item--active" : ""
            }`
          }
          aria-label="Settings"
          title={labeledNav ? undefined : "Settings"}
        >
          <IconSettings size={18} />
          <span className="topbar__nav-label">Settings</span>
        </NavLink>
      </nav>

      {/* Phones: Settings is the icon in the bar's corner, where the
          section menu used to be. */}
      <NavLink
        to="/settings"
        className={({ isActive }) =>
          `topbar__nav-item topbar__settings-btn${isActive ? " topbar__nav-item--active" : ""}`
        }
        aria-label="Settings"
        title="Settings"
      >
        <IconSettings size={18} />
      </NavLink>
    </header>
  );
}

/* ---- scan status ring -------------------------------------------------------
   The determinate arc: once a phase knows its total, the spinner gives
   way to a ring that fills clockwise — the same quiet monochrome, progress
   instead of motion. The numbers live in the label beside it; the ring is
   decoration with a duty, aria-hidden like the spinner it replaces. */
function ScanRing({ fraction }: { fraction: number }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <svg className="topbar__scan-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="topbar__scan-ring-track" cx="8" cy="8" r={r} />
      <circle
        className="topbar__scan-ring-fill"
        cx="8"
        cy="8"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fraction)}
      />
    </svg>
  );
}

/* ---- spotlight search -----------------------------------------------------
   The field plus its drop panel, as one zone. The panel is deliberately
   position-anchored chrome (not a route): results appear under the user's
   hands while the page behind never changes. */

const SUGGEST_ID = "topbar-suggest";
/** Option ids: a suggestion's flat index, or -1 for "See all results". */
const optionId = (idx: number) => (idx < 0 ? "suggest-opt-all" : `suggest-opt-${idx}`);

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

  // One request per pause in typing, not per keystroke — and a request
  // the next query overtook is aborted (the signal), not left to land.
  const settledQ = useDebouncedValue(q, DEBOUNCE_MS);
  const search = useQuery({
    queryKey: ["search", settledQ],
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/api/search", {
        params: { query: { q: settledQ } },
        signal,
      });
      return data;
    },
    // On /search the page below IS the results — the panel stays shut.
    enabled: settledQ.length > 0 && open && pathname !== "/search",
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
          // Playing from the search suggestions names the query.
          playTracks(results.tracks, i, {
            kind: "filter",
            label: `“${q}”`,
            href: `/search?q=${encodeURIComponent(q)}`,
          });
        },
      });
    });
    results.albums.slice(0, 4).forEach((a) => {
      list.push({
        key: `a-${a.id}`,
        render: () => (
          <>
            <Artwork artworkId={a.cover_artwork_id ?? a.artwork_id} size={28} radius="s" />
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
              <Artwork
                artworkId={a.cover_artwork_id ?? a.artwork_id}
                size={28}
                radius="s"
              />
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
              {fmtCount(p.track_count)} song{p.track_count === 1 ? "" : "s"}
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
      { label: "Songs", count: Math.min(4, results?.tracks.length ?? 0) },
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
      // The outside tap must also end the field's focus: on touch devices
      // the panel unmounts mid-tap and the keyboard would otherwise stay
      // up, stranding the input's focus state after the close.
      inputRef.current?.blur();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const panelOpen = open && q.length > 0 && pathname !== "/search";
  // The highlighted option, by id, for aria-activedescendant. With nothing
  // highlighted, Enter means "See all results" — that row is the active one.
  const activeOptionId =
    results && items.length > 0 ? optionId(activeIdx >= 0 ? activeIdx : -1) : undefined;

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
      {/* A <label>, not a div: the pill's whole surface — padding strips
          included — focuses the field. The input keeps its aria-label; a
          wrapping label without text adds nothing, overrides nothing. */}
      <label className="topbar__search">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          className="topbar__input"
          type="search"
          name="q"
          placeholder="Albums, artists, songs, playlists…"
          value={text}
          aria-label="Search library"
          title={`Search (/ or ${MOD_KEY}F)`}
          // The ARIA combobox contract: the field owns the panel, says
          // whether it is open, and points at the highlighted option so a
          // screen reader follows the arrows (focus never leaves the field).
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={panelOpen}
          aria-controls={SUGGEST_ID}
          aria-activedescendant={panelOpen ? activeOptionId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim()) setOpen(true);
          }}
          onFocus={() => {
            if (text.trim()) setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
        />
      </label>

      {panelOpen && (
        <div className="suggest" id={SUGGEST_ID} role="listbox" aria-label="Search results">
          {search.isFetching && !results ? (
            <div className="suggest__loading" role="option" aria-selected={false} aria-disabled="true">
              Searching…
            </div>
          ) : results && items.length === 0 ? (
            <div className="suggest__loading" role="option" aria-selected={false} aria-disabled="true">
              No results for “{q}”
            </div>
          ) : results ? (
            <>
              {groups.map((g) => (
                <div
                  key={g.label}
                  className="suggest__group"
                  role="group"
                  aria-labelledby={`suggest-group-${g.label}`}
                >
                  <span className="suggest__grouplabel" id={`suggest-group-${g.label}`}>
                    {g.label}
                  </span>
                  {items
                    .slice(g.from, g.from + g.count)
                    .map((item, i) => {
                      const idx = g.from + i;
                      return (
                        <button
                          key={item.key}
                          id={optionId(idx)}
                          type="button"
                          role="option"
                          // Options are reached with the arrows from the
                          // field, not with Tab.
                          tabIndex={-1}
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
                id={optionId(-1)}
                role="option"
                tabIndex={-1}
                aria-selected={activeIdx === -1}
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
