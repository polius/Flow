/* Queue drawer (§9.2, §9.4): the full queue as one continuous list in play
   order (identity or shuffled — the store's `order` is the truth). Played
   tracks stay in place, dimmed; the playing row is marked with pulsing
   accent bars over its artwork (§17.7) — nothing disappears as the queue
   advances. Rows are click-to-jump: any row starts playback from there,
   backwards included; the playing row toggles playback. Remove stays
   hover-revealed on non-playing rows. Queue manipulation only — no
   ratings, no play counts (§1).
   The list is windowed — playing a full library queues 10k rows, and the
   drawer must open as smoothly as the Tracks view. */

import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { fmtDuration } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { Artwork } from "./Artwork";
import { IconClose, IconPause, IconPlay } from "./icons";
import "../styles/nowplaying.css";

/* .queue__row: 38px artwork + 7px padding × 2 — fixed-height rows. */
const ROW_HEIGHT = 52;

export function QueuePanel() {
  const queue = usePlayerStore((s) => s.queue);
  const order = usePlayerStore((s) => s.order);
  const orderPos = usePlayerStore((s) => s.orderPos);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playAt = usePlayerStore((s) => s.playAt);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const lastOrderRef = useRef(order);

  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Keep the playing row findable in the full list: center it once when the
  // drawer opens or the queue is replaced, then follow it only when it
  // scrolls out of view — never yank the list while the user is reading it.
  useEffect(() => {
    const list = listRef.current;
    if (!list || order.length === 0 || orderPos >= order.length) return;
    const isNewQueue = lastOrderRef.current !== order;
    lastOrderRef.current = order;
    const top = orderPos * ROW_HEIGHT;
    const inView =
      top >= list.scrollTop &&
      top + ROW_HEIGHT <= list.scrollTop + list.clientHeight;
    if (mountedRef.current && !isNewQueue && inView) return;
    const smooth = mountedRef.current && !isNewQueue;
    mountedRef.current = true;
    list.scrollTo({
      top: Math.max(0, top - list.clientHeight / 2 + ROW_HEIGHT / 2),
      behavior: smooth ? "smooth" : "auto",
    });
  }, [order, orderPos]);

  return (
    <aside className="queue" aria-label="Queue">
      <header className="queue__head">
        <h2 className="queue__title">Queue</h2>
        {order.length > 0 && (
          <span className="queue__count">
            {orderPos + 1} of {order.length}
          </span>
        )}
      </header>

      <div className="queue__list" ref={listRef}>
        {order.length === 0 ? (
          <p className="queue__empty">
            Nothing queued yet — play an album or playlist, or use “Play Next”
            in any track’s ··· menu.
          </p>
        ) : (
          <div
            className="queue__window"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const t = queue[order[item.index]];
              if (!t) return null;
              const isCurrent = item.index === orderPos;
              const played = item.index < orderPos;
              const rowClass = [
                "queue__row",
                isCurrent && "queue__row--current",
                played && "queue__row--played",
              ]
                .filter(Boolean)
                .join(" ");
              const activate = () =>
                isCurrent ? togglePlay() : playAt(item.index);
              return (
                <div
                  key={`${order[item.index]}-${t.id}-${item.index}`}
                  className={rowClass}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <div
                    className="queue__main"
                    role="button"
                    tabIndex={0}
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={activate}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate();
                      }
                    }}
                    title={isCurrent ? undefined : `Play ${t.title}`}
                  >
                    <div className="queue__art">
                      <Artwork artworkId={t.artwork_id} size={38} radius="s" />
                      {isCurrent && (
                        <>
                          <span className="queue__scrim" aria-hidden="true" />
                          <span
                            className={
                              isPlaying ? "eq" : "eq eq--paused"
                            }
                            aria-hidden="true"
                          >
                            <span />
                            <span />
                            <span />
                          </span>
                          <span className="queue__toggle" aria-hidden="true">
                            {isPlaying ? (
                              <IconPause size={14} />
                            ) : (
                              <IconPlay size={14} />
                            )}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="queue__meta">
                      <span className="queue__name">{t.title}</span>
                      <span className="queue__sub">{t.artist ?? " "}</span>
                    </div>
                    <span className="queue__time">
                      {fmtDuration(t.duration)}
                    </span>
                  </div>
                  {!isCurrent && (
                    <button
                      type="button"
                      className="queue__remove"
                      aria-label={`Remove ${t.title} from queue`}
                      title="Remove from queue"
                      onClick={() => removeFromQueue(order[item.index])}
                    >
                      <IconClose size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
