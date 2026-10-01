import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { queryClient } from "./api/queryClient";
import { initTheme } from "./lib/theme";
import { router } from "./router";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/views.css";

// Resolve the theme before the first paint (§8.6).
initTheme();

// The offline shell (§4.2): registered in production only — dev runs under
// Vite HMR, where a service worker would only lie about freshness. An
// unregistered shell degrades to the pre-SW behavior: online-only.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Quiet by design: the shell is a graceful extra, never a surface.
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
