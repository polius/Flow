import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep vendor prefixes the CSS minifier would otherwise strip as
    // duplicates of the standard property: old iOS Safari (pre-15.4)
    // only honors -webkit-appearance, which the search field relies on.
    cssTarget: "safari13",
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
