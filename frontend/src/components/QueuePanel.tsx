/* Queue drawer (§9.2, §9.4): the current track on top, then what's next in
   play order (identity or shuffled — the store's `order` is the truth).
   Upcoming tracks can be removed; the current one keeps playing regardless.
   Queue manipulation only — no ratings, no play counts (§1). */

import { fmtDuration } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { Artwork } from "./Artwork";
import { IconClose } from "./icons";
import "../styles/nowplaying.css";

interface UpcomingEntry {
  queueIndex: number;
  title: string;
  artist: string | null;
  artworkId: number | null;
  duration: number;
  /** Duplicates are legal (play-next twice); key by queue position. */
  key: string;
}

export function QueuePanel() {
  const queue = usePlayerStore((s) => s.queue);
  const order = usePlayerStore((s) => s.order);
  const orderPos = usePlayerStore((s) => s.orderPos);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);

  const current = queue[order[orderPos]];
  const upcoming: UpcomingEntry[] = order
    .slice(orderPos + 1)
    .map((queueIndex, i) => {
      const t = queue[queueIndex];
      return {
        queueIndex,
        title: t.title,
        artist: t.artist,
        artworkId: t.artwork_id,
        duration: t.duration,
        key: `${queueIndex}-${t.id}-${i}`,
      };
    });

  return (
    <aside className="queue" aria-label="Queue">
      <header className="queue__head">
        <h2 className="queue__title">Queue</h2>
        <span className="queue__count">
          {upcoming.length} up next
        </span>
      </header>

      <div className="queue__list">
        {current && (
          <>
            <div className="queue__label">Now playing</div>
            <div className="queue__row queue__row--current">
              <Artwork artworkId={current.artwork_id} size={38} radius="s" />
              <div className="queue__meta">
                <span className="queue__name">{current.title}</span>
                <span className="queue__sub">{current.artist ?? " "}</span>
              </div>
              <span className="queue__time">{fmtDuration(current.duration)}</span>
            </div>
          </>
        )}

        {upcoming.length > 0 && <div className="queue__label">Up next</div>}
        {upcoming.map((entry) => (
          <div key={entry.key} className="queue__row">
            <Artwork artworkId={entry.artworkId} size={38} radius="s" />
            <div className="queue__meta">
              <span className="queue__name">{entry.title}</span>
              <span className="queue__sub">{entry.artist ?? " "}</span>
            </div>
            <span className="queue__time">{fmtDuration(entry.duration)}</span>
            <button
              type="button"
              className="queue__remove"
              aria-label={`Remove ${entry.title} from queue`}
              title="Remove from queue"
              onClick={() => removeFromQueue(entry.queueIndex)}
            >
              <IconClose size={13} />
            </button>
          </div>
        ))}

        {upcoming.length === 0 && (
          <p className="queue__empty">
            Nothing up next — “Play Next” in any track’s ··· menu feeds this queue.
          </p>
        )}
      </div>
    </aside>
  );
}
