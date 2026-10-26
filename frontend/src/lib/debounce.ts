import { useEffect, useState } from "react";

/** `value`, settled: it follows only after `delayMs` without a change.
    An empty value follows at once — clearing a field never waits. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return value === "" || value == null ? value : settled;
}
