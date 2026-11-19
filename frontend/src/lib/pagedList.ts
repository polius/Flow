/* A long list read in pages, at random access. The list is as long as the
   server says it is (`total`) from the first answer, and a page is fetched
   when the window scrolls over it — not only in order from the top. So the
   scrollbar spans the whole library, the last row is reachable, and a jump
   to "M" loads the page M lives on.

   `items` has one slot per row: the row's data, or undefined while its page
   is on the way. Pages are ordinary queries under `queryKey`, so the usual
   invalidations and in-place cache patches reach them. */

import { useCallback, useState } from "react";
import {
  useQueries,
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";

export interface Page<T> {
  items: T[];
  total: number;
}

export interface PagedList<T> {
  /** Rows in the whole list; undefined until the first page answers. */
  total: number | undefined;
  /** One slot per row; undefined where the page has not arrived. */
  items: (T | undefined)[];
  /** How many slots are filled. */
  loaded: number;
  /** No page has answered yet. */
  isPending: boolean;
  /** No page has answered, and the first one failed. */
  isError: boolean;
  refetch: () => void;
  /** Make sure the pages under rows [start, end] are loaded or loading. */
  ensure: (start: number, end: number) => void;
}

export function usePagedList<T>(
  queryKey: QueryKey,
  pageSize: number,
  fetchPage: (offset: number, limit: number) => Promise<Page<T> | undefined>,
): PagedList<T> {
  // The pages this view has asked for. A new key (a re-sort, a filter)
  // starts over from the first page.
  const keyHash = JSON.stringify(queryKey);
  const [wanted, setWanted] = useState<{ key: string; pages: number[] }>({
    key: keyHash,
    pages: [0],
  });
  const pages = wanted.key === keyHash ? wanted.pages : [0];
  const pagesKey = pages.join(",");

  // The slots are assembled in `combine`, which react-query re-runs only
  // when a page's result (or this function) changes — not on every render.
  const combine = useCallback(
    (results: UseQueryResult<Page<T> | undefined>[]) => {
      const total = results.find((r) => r.data != null)?.data?.total;
      const items: (T | undefined)[] = new Array<T | undefined>(total ?? 0).fill(undefined);
      let loaded = 0;
      results.forEach((result, i) => {
        const base = pages[i] * pageSize;
        result.data?.items.forEach((item, k) => {
          if (base + k < items.length) {
            items[base + k] = item;
            loaded++;
          }
        });
      });
      return {
        total,
        items,
        loaded,
        isPending: total === undefined && results.some((r) => r.isPending),
        isError: total === undefined && results.some((r) => r.isError),
      };
    },
    // `pagesKey` names the set of pages; `pages` itself is a new array
    // on some renders that change nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pagesKey, pageSize],
  );

  const list = useQueries({
    queries: pages.map((page) => ({
      queryKey: [...queryKey, "page", pageSize, page],
      queryFn: () => fetchPage(page * pageSize, pageSize),
      // A re-sort must not tear the list down to a skeleton while its
      // first page loads: the previous rows stay until the new ones land.
      placeholderData: (prev: Page<T> | undefined) => prev,
    })),
    combine,
  });

  const ensure = useCallback(
    (start: number, end: number) => {
      const first = Math.max(0, Math.floor(start / pageSize));
      const last = Math.max(first, Math.floor(Math.max(start, end) / pageSize));
      setWanted((cur) => {
        const have = cur.key === keyHash ? cur.pages : [0];
        const missing: number[] = [];
        for (let p = first; p <= last; p++) if (!have.includes(p)) missing.push(p);
        if (missing.length === 0 && cur.key === keyHash) return cur;
        return { key: keyHash, pages: [...have, ...missing] };
      });
    },
    [keyHash, pageSize],
  );

  const queryClient = useQueryClient();
  const refetch = () => void queryClient.invalidateQueries({ queryKey });

  return { ...list, refetch, ensure };
}
