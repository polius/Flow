/* GenreMenu (§2.2): the genre filter pill for the Tracks view. Genres are
   parsed from tags at scan time; browsing lives as a FILTER on the
   everything-view — the nav's section set is settled (§18, §23), and a
   genre's natural destination is "its songs", which this table already is.
   Same grammar as the sort pill: URL state, shared menu surface, Esc/outside
   tap lifecycle. */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { IconCheck } from "./icons";

interface GenreMenuProps {
  value: number | null; // active genre id, null = all
  onChange: (id: number | null) => void;
}

export function GenreMenu({ value, onChange }: GenreMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ["genres"],
    queryFn: async () => {
      const { data } = await api.GET("/api/genres", {
        params: { query: { limit: 1000 } },
      });
      return data;
    },
  });
  const genres = data?.items ?? [];
  const active = genres.find((g) => g.id === value) ?? null;

  // Menu lifecycle: outside tap, Esc, teardown (shared menu grammar).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="sortmenu" ref={wrapRef}>
      <button
        type="button"
        className="view__action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Genre: ${active?.name ?? "All"}`}
        onClick={() => setOpen((o) => !o)}
      >
        {active?.name ?? "Genre"}
      </button>
      {open && (
        <div className="trackmenu sortmenu__pop" role="menu" aria-label="Filter by genre">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value == null}
            className="trackmenu__item"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <span className="trackmenu__check" aria-hidden="true">
              {value == null && <IconCheck size={13} />}
            </span>
            All genres
          </button>
          {genres.map((g) => (
            <button
              key={g.id}
              type="button"
              role="menuitemradio"
              aria-checked={g.id === value}
              className="trackmenu__item"
              onClick={() => {
                onChange(g.id);
                setOpen(false);
              }}
            >
              <span className="trackmenu__check" aria-hidden="true">
                {g.id === value && <IconCheck size={13} />}
              </span>
              {g.name}
              <span className="trackmenu__count">{g.track_count}</span>
            </button>
          ))}
          {genres.length === 0 && (
            <div className="trackmenu__note">No genres in this library yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
