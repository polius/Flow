/* The shell's canvas is the one scroll container every view shares. */

import { useEffect, useRef } from "react";

/** Scroll the canvas back to the top when one of `keys` changes — a new
    ordering or filter is a new list. Not on mount: where a view opens is
    the shell's decision (the top for a new page, the remembered position
    when it is reached with Back). */
export function useCanvasTopOnChange(...keys: unknown[]): void {
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    document.querySelector<HTMLElement>(".shell__canvas")?.scrollTo(0, 0);
    // The caller's keys are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, keys);
}
