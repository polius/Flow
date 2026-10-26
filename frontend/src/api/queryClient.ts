import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // A refocus refetched every LOADED page of every paged list — 30
      // sequential GETs after scrolling 30k rows. Library data changes
      // through this app's own writes and scans, both of which invalidate
      // what they touch.
      refetchOnWindowFocus: false,
    },
  },
});

/** Everything a library change can move — lists, grids, details, search,
    genres, review counts, and the settings counts — in one helper, so
    scans and edits can't drift apart again (a finished first scan once
    left Home's "Recently added" empty; renamed albums kept their old
    names in the grids). Only mounted queries refetch; the rest are marked
    stale for their next visit. */
export function invalidateLibrary(client: QueryClient = queryClient): void {
  for (const key of [
    "tracks",
    "albums",
    "album",
    "artists",
    "artist",
    "playlists",
    "playlist",
    "search",
    "genres",
    "review",
    "settings",
    "scan",
    "suggest",
    "consequences",
  ]) {
    void client.invalidateQueries({ queryKey: [key] });
  }
}
