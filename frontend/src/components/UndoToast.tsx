/* The undo toast: destructive-but-recoverable actions happen at once and a
   quiet pill offers Undo for a few seconds instead of a confirmation
   dialog. One notice at a time — a new action replaces the old, so undo is
   single-generation. Hover or focus holds the timer; a reader mid-decision
   must not watch the door close. */

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
