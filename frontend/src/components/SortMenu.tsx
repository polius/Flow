/* Sort control for views without exposed column machinery on phones: a
   quiet pill (IconSort + current option) opening the shared menu surface.
   Picking the active option flips the direction — the Finder habit — and
   each option carries its own natural direction (recency reads descending,
   names read ascending). Desktop tables also get clickable column headers;
   this pill is the discoverable entry point for both pointer kinds. */

import { useEffect, useRef, useState } from "react";

import { IconCheck, IconChevronDown, IconSort } from "./icons";

export interface SortOption {
  key: string;
  label: string;
  /** Direction applied when the option is first picked. */
  defaultDir?: "asc" | "desc";
}

interface SortMenuProps {
  options: SortOption[];
  value: string;
  dir: "asc" | "desc";
  onChange: (key: string, dir: "asc" | "desc") => void;
  /** Screen-reader label; the visible pill shows the active option. */
  label?: string;
}

export function SortMenu({ options, value, dir, onChange, label = "Sort" }: SortMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = options.find((o) => o.key === value);

  // Menu lifecycle: outside tap, Esc, and route teardown (unmount).
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

  const pick = (key: string) => {
    if (key === value) {
      onChange(key, dir === "asc" ? "desc" : "asc");
    } else {
      const option = options.find((o) => o.key === key);
      onChange(key, option?.defaultDir ?? "asc");
    }
    setOpen(false);
  };

  return (
    <div className="sortmenu" ref={wrapRef}>
      <button
        type="button"
        className="view__action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${active?.label ?? ""}, ${dir === "asc" ? "ascending" : "descending"}`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconSort size={15} />
        {active?.label ?? label}
        <span
          className={`sortmenu__dir${dir === "desc" ? " sortmenu__dir--desc" : ""}`}
          aria-hidden="true"
        >
          <IconChevronDown size={12} />
        </span>
      </button>
      {open && (
        <div className="trackmenu sortmenu__pop" role="menu" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitemradio"
              aria-checked={o.key === value}
              className="trackmenu__item"
              onClick={() => pick(o.key)}
            >
              <span className="trackmenu__check" aria-hidden="true">
                {o.key === value && <IconCheck size={13} />}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
