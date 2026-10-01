/* The undo toast (§25): the app's answer to destructive-but-recoverable
   actions. Removing a track from a playlist is frequent and low-stakes, so
   instead of a confirmation dialog — friction on every intended removal —
   the action happens at once and a quiet pill above the player bar offers
   Undo for a few seconds (iOS Mail's snackbar grammar).

   One notice at a time: a new action replaces the old (the pill remounts
   and its timer restarts), so undo is single-generation — the same
   convention as Organize's bulk undo (§22.6). Hover or focus holds the
   timer; a reader mid-decision must not watch the door close. */

import { useEffect, useState } from "react";

import { useUiStore } from "../stores/ui";
import "../styles/editing.css";

const TOAST_MS = 5000;

export function UndoToast() {
  const notice = useUiStore((s) => s.undoNotice);
  const clearUndoNotice = useUiStore((s) => s.clearUndoNotice);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!notice || held) return;
    const t = window.setTimeout(clearUndoNotice, TOAST_MS);
    return () => window.clearTimeout(t);
  }, [notice, held, clearUndoNotice]);

  if (!notice) return null;

  return (
    <div
      key={notice.id}
      className="undotoast"
      role="status"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="undotoast__msg">{notice.message}</span>
      {notice.undo && (
        <button
          type="button"
          className="undotoast__undo"
          onClick={() => {
            clearUndoNotice();
            void notice.undo?.();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
