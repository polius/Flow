/* The song's lyrics, as the server reads them from its own files, and
   which line is being sung. */

import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";

export function useLyrics(trackId: number | null | undefined) {
  return useQuery({
    queryKey: ["lyrics", trackId],
    queryFn: async () => {
      const { data } = await api.GET("/api/tracks/{track_id}/lyrics", {
        params: { path: { track_id: trackId! } },
      });
      return data ?? null;
    },
    enabled: trackId != null,
    // A song's files change with a rescan, not while it plays.
    staleTime: 5 * 60_000,
  });
}

export interface LyricsData {
  synced: boolean;
  lines: { time: number | null; text: string }[];
}

/** The index of the line being sung at `position` (-1 before the first). */
export function currentLine(lines: LyricsData["lines"], position: number): number {
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].time;
    if (t == null || t > position) break;
    at = i;
  }
  return at;
}
