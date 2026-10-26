/* The in-app 404 and the last-resort route error page.

   NotFoundView renders INSIDE the shell (the `*` route under AppShell):
   a mistyped or stale link keeps the top bar, the player and the queue —
   only the canvas says the page doesn't exist.

   RouteErrorView is the root `errorElement`: a render error anywhere in
   the tree lands here instead of React Router's developer screen. It
   cannot rely on the shell (the shell may be what threw), so it is a
   self-contained page with a reload and a way home. */

import { Link, isRouteErrorResponse, useRouteError } from "react-router";

import { EmptyState } from "../components/EmptyState";
import { IconMusicNote } from "../components/icons";
import "../styles/library.css";

export function NotFoundView() {
  return (
    <section className="view view--fill">
      <EmptyState
        icon={<IconMusicNote size={26} />}
        title="Page not found"
        hint="This link doesn’t lead anywhere in your library — it may be mistyped, or point at something that was removed."
        action={
          <Link to="/" className="btn empty-state__action">
            Go to Home
          </Link>
        }
        headingLevel={1}
      />
    </section>
  );
}

export function RouteErrorView() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="route-error">
      <EmptyState
        icon={<IconMusicNote size={26} />}
        title={notFound ? "Page not found" : "Something went wrong"}
        hint={
          notFound
            ? "This link doesn’t lead anywhere in your library."
            : "Flow hit an unexpected problem showing this page. Reloading usually fixes it; your library and queue are safe."
        }
        action={
          <span className="route-error__actions">
            {!notFound && (
              <button
                type="button"
                className="btn--primary"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            )}
            {/* A plain anchor, not <Link>: a full navigation resets whatever
                state took the tree down. */}
            <a href="/" className="btn">
              Go to Home
            </a>
          </span>
        }
        headingLevel={1}
      />
    </main>
  );
}
