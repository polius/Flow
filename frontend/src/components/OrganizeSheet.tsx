/* Organize sheet (§22, §23 revision): Organize is a task, not a section.
   It slides up over the whole app — playback continues underneath, the
   Tracks view stays put behind it — and Done/Esc hands control back exactly
   where it was. The same full-screen-sheet grammar the Now Playing takeover
   uses, applied to a working context.

   The sheet owns the scroll container (class `shell__canvas` so the grid's
   virtualizer binds to it via the same closest() lookup the main canvas
   uses — one pattern, two surfaces). */

import { useEffect } from "react";

import { isTypingTarget } from "../lib/shortcuts";
import { useUiStore } from "../stores/ui";
import { IconChevronDown, IconOrganize } from "./icons";
import { OrganizeView } from "../views/OrganizeView";
import "../styles/organize.css";

export function OrganizeSheet() {
  const open = useUiStore((s) => s.organizeOpen);
  const close = useUiStore((s) => s.closeOrganize);

  // Esc closes — but yields to whatever sits above it: the library picker,
  // open menus, Get Info, and inline edits close first (§15.7).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ui = useUiStore.getState();
      if (ui.pickerOpen || ui.contextMenuOpen || ui.getInfoTrackId != null) return;
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="orgsheetwrap" role="dialog" aria-modal="true" aria-label="Organize">
      <header className="orgsheetwrap__bar">
        <div className="orgsheetwrap__id">
          <span className="orgsheetwrap__mark" aria-hidden="true">
            <IconOrganize size={16} />
          </span>
          <div>
            <h1 className="orgsheetwrap__title">Organize</h1>
            <p className="orgsheetwrap__sub">
              Group tracks into albums and artists. Edits live in Flow — your
              files are never touched.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="orgsheetwrap__done"
          onClick={close}
          title="Done (Esc)"
        >
          Done
          <IconChevronDown size={13} />
        </button>
      </header>
      <div className="shell__canvas orgsheetwrap__canvas">
        <OrganizeView />
      </div>
    </div>
  );
}
