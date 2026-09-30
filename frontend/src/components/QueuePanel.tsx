/* Queue drawer (§9.2, §9.4): the full queue as one continuous list in play
   order (identity or shuffled — the store's `order` is the truth). Played
   tracks stay in place, dimmed; the playing row is marked with pulsing
   accent bars over its artwork (§17.7) — nothing disappears as the queue
   advances. Rows are click-to-jump: any row starts playback from there,
   backwards included; the playing row toggles playback. The playing row is
   anchored — it can't be dragged or removed (§9.4: playback is the thing
   the user can't undo with one gesture).
   Reorder (§9.4 revision): drag a row to any position — the plan is the
   truth, so dragging writes straight into the play order (shuffle-aware).
   On touch, where HTML5 drag doesn't exist, a horizontal swipe removes a
   row (the iOS Mail gesture) and the always-visible ✕ stays as the
   discoverable path. Queue manipulation only — no ratings, no play counts.
   The queue is also where one is BUILT (§23): the header's Add button opens
   the shared library picker and appends to the end of the play order.
   The list is windowed — playing a full library queues 10k rows. */

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { fmtDuration } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { AddTracksDialog } from "./AddTracksDialog";
import { Artwork } from "./Artwork";
import {
  IconChevronDown,
  IconClose,
  IconPause,
  IconPlay,
  IconPlus,
  IconTrash,
} from "./icons";
import "../styles/nowplaying.css";

/* .queue__row: 38px artwork + 7px padding × 2 — fixed-height rows. */
const ROW_HEIGHT = 52;
/** A swipe past this many pixels commits the removal. */
const SWIPE_COMMIT_PX = 96;
/** Movement below this is a tap, not a swipe. */
const SWIPE_START_PX = 8;

interface QueuePanelProps {
  /** Narrow-window sheet mode (§23): a chevron returns to the stage. */
  onCollapse?: () => void;
}

export function QueuePanel({ onCollapse }: QueuePanelProps) {
  const queue = usePlayerStore((s) => s.queue);
  const order = usePlayerStore((s) => s.order);
  const orderPos = usePlayerStore((s) => s.orderPos);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playAt = usePlayerStore((s) => s.playAt);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const moveInQueue = usePlayerStore((s) => s.moveInQueue);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const [adding, setAdding] = useState(false);

  // Drag-to-reorder state (order indexes, insertion slots).
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Touch swipe-to-remove state: one active gesture at a time.
  const [swipe, setSwipe] = useState<{ index: number; dx: number } | null>(null);
  const swipeRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    index: number;
    decided: boolean;
  }>({ pointerId: null, startX: 0, startY: 0, index: -1, decided: false });

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
    const top = Math.max(0, orderPos) * ROW_HEIGHT;
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

  const handleDrop = () => {
    if (dragFrom != null && dropAt != null) moveInQueue(dragFrom, dropAt);
    setDragFrom(null);
    setDropAt(null);
  };

  const endSwipe = () => {
    setSwipe(null);
    swipeRef.current.pointerId = null;
    swipeRef.current.decided = false;
  };

  const onSwipeStart = (index: number) => (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    if (swipeRef.current.pointerId != null) return;
    swipeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      index,
      decided: false,
    };
  };

  const onSwipeMove = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    if (s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.decided) {
      // One decision per gesture: horizontal swipes are ours, vertical
      // belongs to the scroller. Rows only leave by swiping left.
      if (Math.abs(dx) < SWIPE_START_PX && Math.abs(dy) < SWIPE_START_PX) return;
      if (Math.abs(dy) >= Math.abs(dx) || dx > 0) {
        s.pointerId = null;
        return;
      }
      s.decided = true;
    }
    setSwipe({ index: s.index, dx: Math.min(0, Math.max(-140, dx)) });
  };

  const onSwipeEnd = () => {
    const s = swipeRef.current;
    if (s.pointerId == null) return;
    const current = swipe;
    if (current && current.dx <= -SWIPE_COMMIT_PX) {
      removeFromQueue(order[current.index]);
    }
    endSwipe();
  };

  return (
    <>
      <aside className="queue" id="queue-panel" aria-label="Queue">
        <header className="queue__head">
          <div className="queue__headleft">
            {onCollapse && (
              <button
                type="button"
                className="queue__back"
                onClick={onCollapse}
                aria-label="Close queue"
                title="Close queue"
              >
                <IconChevronDown size={16} />
              </button>
            )}
            <h2 className="queue__title">Queue</h2>
          </div>
          <div className="queue__headright">
            <button
              type="button"
              className="queue__add"
              onClick={() => setAdding(true)}
              aria-haspopup="dialog"
            >
              <IconPlus size={13} />
              Add
            </button>
            {order.length > 0 && (
              <span className="queue__count">
                {orderPos >= 0
                  ? `${orderPos + 1} of ${order.length}`
                  : `${order.length} ${order.length === 1 ? "track" : "tracks"}`}
              </span>
            )}
          </div>
        </header>

        <div className="queue__list" ref={listRef}>
          {order.length === 0 ? (
            <div className="queue__empty">
              <p className="queue__emptytitle">Nothing queued</p>
              <p className="queue__emptyhint">
                Play an album or playlist anywhere in Flow — or add tracks here to
                line up what plays next.
              </p>
              <button type="button" className="queue__add" onClick={() => setAdding(true)}>
                <IconPlus size={13} />
                Add Tracks
              </button>
            </div>
          ) : (
            <div
              className="queue__window"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const t = queue[order[item.index]];
                if (!t) return null;
                const isCurrent = item.index === orderPos;
                const played = orderPos >= 0 && item.index < orderPos;
                const rowClass = [
                  "queue__row",
                  isCurrent && "queue__row--current",
                  played && "queue__row--played",
                  dragFrom === item.index && "queue__row--dragging",
                  dropAt === item.index && "queue__row--dropbefore",
                  dropAt === order.length &&
                    item.index === order.length - 1 &&
                    "queue__row--dropafter",
                ]
                  .filter(Boolean)
                  .join(" ");
                const activate = () =>
                  isCurrent ? togglePlay() : playAt(item.index);
                const swiping = swipe?.index === item.index && swipe.dx < 0;
                // The row is one click target AND one grab target (the
                // established playlist grammar): draggable on the row itself,
                // so a press-move lifts it while a click still plays. The
                // playing row is anchored — no drag, no remove.
                const dragHandlers: React.HTMLAttributes<HTMLDivElement> = isCurrent
                  ? {}
                  : {
                      draggable: true,
                      onDragStart: (e: React.DragEvent) => {
                        setDragFrom(item.index);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(item.index));
                      },
                      onDragOver: (e: React.DragEvent) => {
                        if (dragFrom == null) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const rect = e.currentTarget.getBoundingClientRect();
                        setDropAt(
                          e.clientY < rect.top + rect.height / 2
                            ? item.index
                            : item.index + 1,
                        );
                      },
                      onDrop: handleDrop,
                      onDragEnd: () => {
                        setDragFrom(null);
                        setDropAt(null);
                      },
                    };
                return (
                  <div
                    key={`${order[item.index]}-${t.id}-${item.index}`}
                    className={rowClass}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {/* Swipe backdrop (touch): a red field with the remove
                        glyph, revealed as the row slides left. */}
                    <span className="queue__swipebg" aria-hidden="true">
                      <IconTrash size={15} />
                    </span>
                    <div
                      className={`queue__main${swiping ? " queue__main--swiping" : ""}`}
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
                      style={
                        swiping ? { transform: `translateX(${swipe.dx}px)` } : undefined
                      }
                      onPointerDown={onSwipeStart(item.index)}
                      onPointerMove={onSwipeMove}
                      onPointerUp={onSwipeEnd}
                      onPointerCancel={onSwipeEnd}
                      {...dragHandlers}
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
      {adding && <AddTracksDialog kind="queue" onClose={() => setAdding(false)} />}
    </>
  );
}
