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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
