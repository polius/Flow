/* TopBar — the persistent search field above the canvas (§9.1). It is the
   single search input: typing navigates to /search?q=… (debounced ~200 ms),
   so the query lives in the URL and deep links work (§9.2). */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { IconSearch } from "./icons";
import { useUiStore } from "../stores/ui";
import "../styles/topbar.css";

const DEBOUNCE_MS = 200;

export function TopBar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [text, setText] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusSignal = useUiStore((s) => s.searchFocusSignal);
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

  return (
    <header className="topbar">
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
    </header>
  );
}
