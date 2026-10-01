import createClient from "openapi-fetch";

import type { Track } from "./types";
import type { paths } from "./schema";

// Same-origin by default: the Vite dev proxy (dev) or nginx (prod) fronts
// the API. No CORS anywhere (DESIGN.md §7).
export const api = createClient<paths>();

/** Page size for whole-view fetches — matches the paged views (§11.6). */
const PAGE_SIZE = 1000;

/** Every track matching a library filter, across all pages (§29). "Play
    from here" means the WHOLE view — a paged table must never queue only
    the pages the window happened to have loaded. Local server, few round
    trips: the await is imperceptible at library scale. */
export async function fetchAllTracks(params: {
  q?: string;
  favorite?: boolean;
  genreId?: number;
  sort: string;
  dir: string;
}): Promise<Track[]> {
  const query = {
    limit: PAGE_SIZE,
    sort: params.sort,
    dir: params.dir as "asc" | "desc",
    ...(params.q ? { q: params.q } : {}),
    ...(params.favorite ? { favorite: true } : {}),
    ...(params.genreId != null ? { genre_id: params.genreId } : {}),
  };
  const { data } = await api.GET("/api/tracks", { params: { query: { ...query, offset: 0 } } });
  const items: Track[] = [...(data?.items ?? [])];
  const total = data?.total ?? 0;
  while (items.length < total) {
    const { data: page } = await api.GET("/api/tracks", {
      params: { query: { ...query, offset: items.length } },
    });
    if (!page || page.items.length === 0) break; // defensive: never loop forever
    items.push(...page.items);
  }
  return items;
}
