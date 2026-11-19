/* "Playing on another device": the server's queue moved to another
   browser (it started playing there) and refused this one's write. The
   listener chooses: take the queue back, or keep listening here without
   touching it. Nothing is overwritten until they do. */

import { usePlayerStore } from "../stores/player";

export function DeviceNotice() {
  const elsewhere = usePlayerStore((s) => s.elsewhere);
  const takeOver = usePlayerStore((s) => s.takeOver);
  const keepListeningHere = usePlayerStore((s) => s.keepListeningHere);
  return (
    <div className="devicenotice-slot" role="status">
      {elsewhere && (
        <div className="devicenotice">
          <span className="devicenotice__msg">Playing on another device.</span>
          <button type="button" className="devicenotice__action" onClick={takeOver}>
            Take Over
          </button>
          <button type="button" className="devicenotice__action" onClick={keepListeningHere}>
            Keep Listening Here
          </button>
        </div>
      )}
    </div>
  );
}
