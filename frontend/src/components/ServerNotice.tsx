/* The shell's word on the server: "Can't reach your server" while it is
   gone (the queue and the player stay usable for what is already loaded),
   and "Flow was updated" with a reload once the server runs a newer build
   than this tab. Floats at the top, over the page and Now Playing alike,
   and can be dismissed until the state changes. */

import { useEffect, useState } from "react";

import { useServerStore, watchServer } from "../lib/serverWatch";
import { IconClose } from "./icons";

export function ServerNotice() {
  const down = useServerStore((s) => s.down);
  const updated = useServerStore((s) => s.updated);
  const kind = down ? "down" : updated ? "updated" : null;
  // Dismissed until the state changes (back online, or another update).
  const [dismissed, setDismissed] = useState<typeof kind>(null);
  const shown = kind != null && kind !== dismissed ? kind : null;

  // Not in unit tests: they mount the shell without a server to ask.
  useEffect(() => (import.meta.env.MODE === "test" ? undefined : watchServer()), []);

  // The live region is always there, so a notice that appears in it is
  // announced. It floats over everything, Now Playing included.
  return (
    <div className="servernotice-slot" role="status">
      {shown && (
        <div className={`servernotice servernotice--${shown}`}>
          <span className="servernotice__msg">
            {shown === "down"
              ? "Can’t reach your server. Flow will reconnect when it’s back."
              : "Flow was updated"}
          </span>
          {shown === "updated" && (
            <button
              type="button"
              className="servernotice__action"
              onClick={() => location.reload()}
            >
              Reload
            </button>
          )}
          {/* On a phone the update notice has no close (see shell.css):
              it stays until the page is reloaded. */}
          <button
            type="button"
            className="servernotice__close"
            aria-label="Dismiss"
            onClick={() => setDismissed(shown)}
          >
            <IconClose size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
