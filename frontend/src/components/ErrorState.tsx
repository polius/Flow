/* Failure placeholder — the third state beside LoadingState and EmptyState.
   A query that failed must never sit on a skeleton forever or claim the
   library is empty ("0 albums"): it says what didn't load and offers the
   retry. Same shape as the empty state so a view swaps one for the other
   without the page jumping. */

import { IconInfo } from "./icons";

interface ErrorStateProps {
  /** What failed to load, as the user would say it: "albums", "this playlist". */
  what: string;
  /** Re-runs the failed request (a query's `refetch`). */
  retry: () => unknown;
}

export function ErrorState({ what, retry }: ErrorStateProps) {
  return (
    <div className="empty-state error-state" role="alert">
      <div className="empty-state__icon" aria-hidden="true">
        <IconInfo size={26} />
      </div>
      <h2 className="empty-state__title">Couldn’t load {what}</h2>
      <p className="empty-state__hint">
        The server didn’t answer as expected. Check that Flow is still running, then try
        again.
      </p>
      <button type="button" className="btn empty-state__action" onClick={() => void retry()}>
        Try Again
      </button>
    </div>
  );
}
