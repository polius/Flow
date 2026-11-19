import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { queryClient } from "./api/queryClient";
import { initHomeIcon } from "./lib/homeIcon";
import { prefetchParts } from "./lib/lazyParts";
import { useServerStore } from "./lib/serverWatch";
import { initTheme } from "./lib/theme";
import { router } from "./router";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/views.css";

// Resolve the theme before the first paint.
initTheme();
initHomeIcon();

// The offline shell (public/sw.js, stamped by scripts/stamp-sw.mjs):
// registered in production only — dev runs under Vite HMR, where a
// service worker would only lie about freshness. An unregistered shell
// degrades to online-only.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Quiet by design: the shell is a graceful extra, never a surface.
    });
  });
}

// A part of this build that loads on demand (a section, Get Info) is gone
// from the server: Flow was updated under this open tab. Load the new
// build, at the page the click was heading to — but only when the server
// is known to run another build. A part that failed for any other reason
// (the server is away, and this page never fetched the part) is left to
// fail where it is: reloading then would trade the open app, and the song
// playing, for the browser's error page. Never twice in ten seconds.
window.addEventListener("vite:preloadError", (event) => {
  if (!useServerStore.getState().updated) return;
  const key = "flow:reloaded-for-update";
  const last = Number(sessionStorage.getItem(key) ?? 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem(key, String(Date.now()));
  event.preventDefault();
  const heading = router.state.navigation.location;
  if (heading) location.assign(heading.pathname + heading.search);
  else location.reload();
});

// Every on-demand part is fetched once the page has settled, so it is in
// the browser's cache before it is needed (see lib/lazyParts.ts).
window.addEventListener("load", () => window.setTimeout(prefetchParts, 3000));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
