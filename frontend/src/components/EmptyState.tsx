import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  hint: ReactNode;
  /** Optional way forward under the hint ("Back to Albums", "Go to Home"). */
  action?: ReactNode;
  /** h1 when the empty state IS the page (404, a missing album); h2 when
      it sits under the view's own title. */
  headingLevel?: 1 | 2;
}

export function EmptyState({ icon, title, hint, action, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        {icon}
      </div>
      <Heading className="empty-state__title">{title}</Heading>
      <p className="empty-state__hint">{hint}</p>
      {action}
    </div>
  );
}
