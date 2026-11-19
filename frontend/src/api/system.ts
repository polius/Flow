/* System identity, read back from the backend.

   /api/health is public (the container healthcheck polls it) and carries
   the version the FastAPI process runs with — the one source of truth in
   app/__init__.py. The topbar badge renders it, so the label can never
   disagree with the server actually answering. */

import { queryOptions, useQuery } from "@tanstack/react-query";

import { api } from "./client";

export function useAppVersion() {
  return useQuery({
    queryKey: ["app", "version"],
    queryFn: async () => {
      const { data } = await api.GET("/api/health");
      return data?.version ?? null;
    },
    // A version is a property of the running process, not of time —
    // a deploy means a page load, which is a fresh cache anyway.
    staleTime: Infinity,
  });
}

/** The settings snapshot (scan state, library counts, options): one query
    shared by Home, Settings and the scan stream's catch-up, so a page load
    asks once. */
export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: async () => {
    const { data } = await api.GET("/api/settings");
    // A 5xx has no body: a failed load, not "no settings".
    if (!data) throw new Error("The server didn't answer");
    return data;
  },
});
