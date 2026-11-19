/* The shell's word on the server: "Can't reach your server" while it is
   gone (the queue and the player stay usable for what is already loaded),
   and "Flow was updated" with a reload once the server runs a newer build
   than this tab. Sits at the top of the page, above the view. */

import { useEffect } from "react";

import { useServerStore, watchServer } from "../lib/serverWatch";

export function ServerNotice() {
  const down = useServerStore((s) => s.down);
  const updated = useServerStore((s) => s.updated);

  // Not in unit tests: they mount the shell without a server to ask.
  useEffect(() => (import.meta.env.MODE === "test" ? undefined : watchServer()), []);

  // The live region is always there, so a notice that appears in it is
  // announced.
  return (
    <div className="servernotice-slot" role="status">
      {down ? (
        <div className="servernotice">
          <span className="servernotice__msg">
            Can’t reach your server. Flow will reconnect when it’s back.
          </span>
        </div>
      ) : updated ? (
        <div className="servernotice">
          <span className="servernotice__msg">Flow was updated.</span>
          <button
            type="button"
            className="servernotice__action"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        </div>
      ) : null}
    </div>
  );
}
