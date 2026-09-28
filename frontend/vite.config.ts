import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev only — nginx fronts the API in production (DESIGN.md §10).
      "/api": "http://127.0.0.1:8000",
    },
  },
});
