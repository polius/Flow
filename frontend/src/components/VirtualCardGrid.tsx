/* A windowed grid of cards (albums, artists). The grid is as tall as the
   whole list, and only the rows of cards on screen exist in the DOM — a
   library of 2,500 albums draws a few dozen cards, not 2,500. The
   virtualizer binds to the shell's .shell__canvas scroll container, like
   the track table.

   The column count mirrors the CSS it replaces (`repeat(auto-fill,
   minmax(min, 1fr))`): as many `minColumn`-wide columns as fit. Rows are
   measured as they render, so a card may be any height. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const OVERSCAN_ROWS = 3;

interface VirtualCardGridProps {
  /** Cards in the whole list. */
  count: number;
  /** The card at `index` — a placeholder while its data is on the way. */
  renderCard: (index: number) => ReactNode;
  /** Narrowest a column may be, and the gaps (px): the CSS grid's numbers. */
  minColumn: number;
  columnGap: number;
  rowGap: number;
  /** A first guess at a card's height beyond its width (the text lines). */
  cardExtra: number;
  className?: string;
  /** Called with the cards the window covers: load the pages under them. */
  onRangeChange?: (start: number, end: number) => void;
  /** Scroll so that card `index` is in the top row. A new `nonce` repeats
      a jump to the same card. */
  jump?: { index: number; nonce: number } | null;
}

export function VirtualCardGrid({
  count,
  renderCard,
  minColumn,
  columnGap,
  rowGap,
  cardExtra,
  className,
  onRangeChange,
  jump,
}: VirtualCardGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Known from the first render whenever the shell is already on screen:
  // see VirtualTrackTable (a late bind resets a restored scroll position).
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(() =>
    document.querySelector<HTMLElement>(".shell__canvas"),
  );
  const [width, setWidth] = useState(0);

  // Measured before the first paint, so the grid is born at its full
  // height (a restored scroll position has somewhere to land).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollEl(el.closest<HTMLElement>(".shell__canvas"));
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((width + columnGap) / (minColumn + columnGap)));
  const columnWidth = (width - (columns - 1) * columnGap) / columns;
  const rows = Math.ceil(count / columns);
  const rowEstimate = Math.max(1, columnWidth + cardExtra + rowGap);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowEstimate,
    overscan: OVERSCAN_ROWS,
    // The grid sits below the view's head inside the scroller.
    scrollMargin: containerRef.current?.offsetTop ?? 0,
  });
  // A new column count is a new set of rows: forget the measured heights.
  useEffect(() => {
    virtualizer.measure();
  }, [columns, rowEstimate, virtualizer]);

  const startRow = virtualizer.range?.startIndex ?? -1;
  const endRow = virtualizer.range?.endIndex ?? -1;
  useEffect(() => {
    if (startRow < 0 || endRow < 0) return;
    onRangeChange?.(
      Math.max(0, (startRow - OVERSCAN_ROWS) * columns),
      (endRow + OVERSCAN_ROWS + 1) * columns - 1,
    );
  }, [startRow, endRow, columns, onRangeChange]);

  const jumpNonce = jump?.nonce;
  useEffect(() => {
    if (jump == null) return;
    virtualizer.scrollToIndex(Math.floor(jump.index / columns), { align: "start" });
    // Only a new jump moves the grid, not a re-render with the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpNonce]);

  const margin = virtualizer.options.scrollMargin;
  return (
    <div
      ref={containerRef}
      className="cardgrid"
      style={{ height: width > 0 ? virtualizer.getTotalSize() : undefined }}
    >
      {width > 0 &&
        virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={row.index}
            className={`cardgrid__row${className ? ` ${className}` : ""}`}
            style={{
              transform: `translateY(${row.start - margin}px)`,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              columnGap,
              paddingBottom: rowGap,
            }}
          >
            {Array.from(
              { length: Math.min(columns, count - row.index * columns) },
              (_, i) => renderCard(row.index * columns + i),
            )}
          </div>
        ))}
    </div>
  );
}
