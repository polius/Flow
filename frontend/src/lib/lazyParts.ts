/* Parts of the app that load on demand: the sections, Now Playing, the
   dialogs. The start stays small, and every part is fetched in the
   background once the page is idle (`prefetchParts`), so it sits in the
   browser's cache before anyone clicks: a server that goes away (or a
   plain-http address, where no service worker runs) still opens Albums or
   Now Playing, as when the app was one bundle.

   A part that comes back empty is a part of an old build the page is
   leaving (main.tsx reloads for it): it never settles, so no error view
   flashes before the new page arrives. */

import { lazy, type ComponentType } from "react";

const loaders: (() => Promise<unknown>)[] = [];

/** Register a part's loader for the background fetch; returns a loader
    that never settles when the module came back empty. */
export function part<M>(load: () => Promise<M>): () => Promise<M> {
  loaders.push(load);
  return async () => {
    const mod = await load();
    if (mod == null) return new Promise<M>(() => {});
    return mod;
  };
}

/** React.lazy over a registered part. */
export function lazyPart<M, P extends object>(
  load: () => Promise<M>,
  pick: (mod: M) => ComponentType<P>,
) {
  const loader = part(load);
  return lazy(async () => ({ default: pick(await loader()) }));
}

/** Fetch every part once, quietly: a failure here costs nothing. */
export function prefetchParts(): void {
  for (const load of loaders) void load().catch(() => {});
}
