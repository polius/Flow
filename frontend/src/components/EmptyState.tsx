/* Designed empty state (DESIGN.md §8.8) — shared by all views. */

import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  hint: ReactNode;
}

export function EmptyState({ icon, title, hint }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__hint">{hint}</p>
    </div>
  );
}
