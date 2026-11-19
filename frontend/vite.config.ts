import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep vendor prefixes the CSS minifier would otherwise strip as
    // duplicates of the standard property: old iOS Safari (pre-15.4)
    // only honors -webkit-appearance, which the search field relies on.
    cssTarget: "safari13",
    // Libraries in files of their own, so a release that changes only
    // Flow's code keeps their names and browsers keep them cached. The
    // list virtualizer is split from the rest because only list views
    // and the queue use it: the first page doesn't wait for it.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          return id.includes("/@tanstack/react-virtual/") || id.includes("/@tanstack/virtual-core/")
            ? "vendor-virtual"
            : "vendor";
        },
      },
    },
  },
  server: {
    proxy: {
      // Dev only — nginx fronts the API in production.
      "/api": "http://127.0.0.1:8000",
    },
  },
  test: {
    environment: "jsdom",
  },
});
