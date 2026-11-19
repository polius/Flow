/* The server watcher (O1): no answer or a 5xx is "down", coming back
   refetches what the outage emptied, and a server whose index.html names
   another entry script than this page's is "updated". */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryClient } from "../api/queryClient";
import { checkServer, entryOf, useServerStore } from "../lib/serverWatch";

const page = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head></html>`;

let health: () => Promise<Response>;
let index: () => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  useServerStore.setState({ down: false, updated: false });
  const script = document.createElement("script");
  script.type = "module";
  script.setAttribute("src", "/assets/index-AAAA.js");
  document.head.appendChild(script);
  health = () => Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
  index = () => Promise.resolve(new Response(page("/assets/index-AAAA.js"), { status: 200 }));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => (url === "/api/health" ? health() : index())),
  );
});

afterEach(() => {
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the server watcher", () => {
  it("reads the entry script out of index.html", () => {
    expect(entryOf(page("/assets/index-B1.js"))).toBe("/assets/index-B1.js");
    expect(entryOf("<html></html>")).toBeNull();
  });

  it("is down when the server does not answer, and when a proxy answers 502", async () => {
    health = () => Promise.reject(new TypeError("Failed to fetch"));
    await checkServer();
    expect(useServerStore.getState().down).toBe(true);

    useServerStore.setState({ down: false });
    health = () => Promise.resolve(new Response("Bad Gateway", { status: 502 }));
    await checkServer();
    expect(useServerStore.getState().down).toBe(true);
  });

  it("refetches everything when the server comes back", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    health = () => Promise.reject(new TypeError("Failed to fetch"));
    await checkServer();
    expect(invalidate).not.toHaveBeenCalled();
    health = () => Promise.resolve(new Response("{}", { status: 200 }));
    await checkServer();
    expect(useServerStore.getState().down).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("says updated only when the server's build is another one", async () => {
    await checkServer();
    expect(useServerStore.getState().updated).toBe(false);
    index = () => Promise.resolve(new Response(page("/assets/index-BBBB.js"), { status: 200 }));
    await checkServer();
    expect(useServerStore.getState().updated).toBe(true);
  });

  it("asks again within seconds while down", async () => {
    health = () => Promise.reject(new TypeError("Failed to fetch"));
    await checkServer();
    health = () => Promise.resolve(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useServerStore.getState().down).toBe(false);
  });
});
