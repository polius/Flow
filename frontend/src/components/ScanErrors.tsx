/* Scan errors: the skipped-files log, in two forms over one query. The
   top-bar pill (while a scan runs) and the Settings "Skipped" section both
   need the same truth — what failed, where, and why — so one component
   renders the list and both surfaces host it. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { fmtCount } from "../lib/format";
import { useModalFocus } from "../lib/focus";
import { useUiStore } from "../stores/ui";
import { IconClose, IconSearch } from "./icons";
import "../styles/views.css";

/** One shared query for the skip log. `live` (a scan in flight) polls —
    the log grows as the scanner walks the library. */
export function useScanErrors(enabled: boolean, live = false) {
  return useQuery({
    queryKey: ["scan", "errors"],
    queryFn: async () => {
      const { data } = await api.GET("/api/scan/errors");
      return (data ?? null);
    },
    enabled,
    refetchInterval: live ? 2000 : false,
  });
}

/** The filter field + list, shared by the dialog and the Settings panel. */
function ScanErrorList({ live }: { live?: boolean }) {
  const [filter, setFilter] = useState("");
  const { data } = useScanErrors(true, live);

  const items = data?.items ?? [];
  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      q
        ? items.filter(
            (i) =>
              i.path.toLowerCase().includes(q) ||
              i.reason.toLowerCase().includes(q),
          )
        : items,
    [items, q],
  );

  const total = data?.total ?? 0;

  return (
    <div className="scanerrors">
      <div className="scanerrors__bar">
        <span className="scanerrors__count" role="status">
          {data === undefined
            ? "Loading…"
            : `${fmtCount(total)} ${total === 1 ? "file" : "files"} skipped`}
        </span>
        {items.length > 3 && (
          <label className="scanerrors__filter">
            <IconSearch size={13} />
            <input
              value={filter}
              placeholder="Filter by path or reason"
              aria-label="Filter skipped files"
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button
                type="button"
                className="scanerrors__filterclear"
                aria-label="Clear filter"
                onClick={() => setFilter("")}
              >
                <IconClose size={11} />
              </button>
            )}
          </label>
        )}
      </div>

      <div className="scanerrors__head" aria-hidden="true">
        <span>File</span>
        <span>Reason</span>
      </div>
      <div className="scanerrors__list" role="list">
        {data !== undefined && shown.length === 0 && (
          <div className="scanerrors__empty">
            {q ? `Nothing matches “${filter.trim()}”.` : "Nothing to show."}
          </div>
        )}
        {shown.map((item) => (
          <div key={item.path} className="scanerrors__row" role="listitem">
            <span className="scanerrors__path" title={item.path}>
              {item.path}
            </span>
            <span className="scanerrors__reason">{item.reason}</span>
          </div>
        ))}
      </div>

      {data?.truncated && (
        <p className="scanerrors__note">
          The scan log keeps the most recent {fmtCount(data.items.length)} of{" "}
          {fmtCount(data.total)} — fix these and rescan to see the rest.
        </p>
      )}
    </div>
  );
}

/** The modal the top-bar error pill opens mid-scan. */
export function ScanErrorsDialog({
  onClose,
  live = false,
}: {
  onClose: () => void;
  live?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useModalFocus(surfaceRef, true);

  // Registered like every modal: Esc precedence — the selection
  // hook and the shortcut guard defer while this is up.
  useEffect(() => {
    useUiStore.getState().setContextMenuOpen(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      useUiStore.getState().setContextMenuOpen(false);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <>
      <div className="scanerrors__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={surfaceRef}
        className="scanerrors__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Skipped files"
      >
        <header className="scanerrors__dialoghead">
          <div>
            <h2 className="scanerrors__dialogtitle">Skipped files</h2>
            <p className="scanerrors__dialogsub">
              {live
                ? "These files could not be read during the scan. Fix them and rescan — your library never loses anything."
                : "From the last scan. Fix them and rescan — your library never loses anything."}
            </p>
          </div>
          <button
            type="button"
            className="scanerrors__close"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={16} />
          </button>
        </header>
        <ScanErrorList live={live} />
      </div>
    </>
  );
}

/** Settings' "Skipped" block: the full list inline — no disclosure, no
    separate read surface. A handful of failures reads at a glance; a
    thousand still filter and scroll in place. */
export function ScanErrorsPanel({ live = false }: { live?: boolean }) {
  return <ScanErrorList live={live} />;
}
