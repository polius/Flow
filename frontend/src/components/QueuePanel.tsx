/* Queue drawer (§9.2, §9.4): the current track on top, then what's next in
   play order (identity or shuffled — the store's `order` is the truth).
   Upcoming tracks can be removed; the current one keeps playing regardless.
   Queue manipulation only — no ratings, no play counts (§1).
   M6: the upcoming list is windowed — playing a full library queues 10k
   rows, and the drawer must open as smoothly as the Tracks view. */

import { useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

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

/* .queue__row: 38px artwork + 7px padding × 2 — fixed-height rows. */
const ROW_HEIGHT = 52;

export function QueuePanel() {
  const queue = usePlayerStore((s) => s.queue);
  const order = usePlayerStore((s) => s.order);
  const orderPos = usePlayerStore((s) => s.orderPos);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);

  const listRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

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

  // The upcoming rows are windowed inside .queue__list (its own scroller).
  // scrollMargin = everything rendered above the windowed region (labels +
  // current row), measured rather than assumed.
  useLayoutEffect(() => {
    const list = listRef.current;
    const win = windowRef.current;
    if (!list || !win) return;
    const measure = () => {
      setScrollMargin(
        win.getBoundingClientRect().top -
          list.getBoundingClientRect().top +
          list.scrollTop,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [current != null, upcoming.length > 0]);

  const virtualizer = useVirtualizer({
    count: upcoming.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
  });

  return (
    <aside className="queue" aria-label="Queue">
      <header className="queue__head">
        <h2 className="queue__title">Queue</h2>
        <span className="queue__count">
          {upcoming.length} up next
        </span>
      </header>

      <div className="queue__list" ref={listRef}>
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
        <div
          className="queue__window"
          ref={windowRef}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const entry = upcoming[item.index];
            return (
              <div
                key={entry.key}
                className="queue__row"
                style={{
                  transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
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
            );
          })}
        </div>

        {upcoming.length === 0 && (
          <p className="queue__empty">
            Nothing up next — “Play Next” in any track’s ··· menu feeds this queue.
          </p>
        )}
      </div>
    </aside>
  );
}
