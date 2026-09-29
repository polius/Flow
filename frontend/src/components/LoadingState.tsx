/* Loading placeholder (§8.8) — quiet inset blocks with a slow pulse.
   Deliberately separate from EmptyState: "still loading" must never read
   as "empty library". The pulse communicates waiting; nothing else moves
   (§8.4), and it stops under prefers-reduced-motion. */

interface LoadingStateProps {
  /** "grid" for cover grids, "detail" for detail headers, "rows" otherwise. */
  variant?: "grid" | "detail" | "rows";
}

export function LoadingState({ variant = "rows" }: LoadingStateProps) {
  if (variant === "grid") {
    return (
      <div className="covergrid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="loading-card">
            <div className="skeleton skeleton--square" />
            <div className="skeleton skeleton--line" style={{ width: "72%" }} />
            <div className="skeleton skeleton--line skeleton--thin" style={{ width: "46%" }} />
          </div>
        ))}
      </div>
    );
  }

  if (variant === "detail") {
    return (
      <div className="detailhead" aria-hidden="true">
        <div className="skeleton skeleton--square skeleton--detail" />
        <div className="loading-detail">
          <div className="skeleton skeleton--line skeleton--title" />
          <div className="skeleton skeleton--line" style={{ width: "38%" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="loading-rows" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="skeleton skeleton--row" />
      ))}
    </div>
  );
}
