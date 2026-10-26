/* Failure is a state of its own (audit D3): a 500 shows the shared error
   state — never a skeleton forever or "0 albums" — and Try Again refetches;
   a 404 detail says "not found" with a way back; an unknown URL renders the
   in-app 404 inside the shell; a render error lands on the root error page. */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("../api/scanSync", () => ({ ensureScanSync: () => {}, stopScanSync: () => {} }));
vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn().mockResolvedValue({ status: "empty" }),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
  playByFilter: vi.fn(),
}));

import { api } from "../api/client";
import { routes } from "../router";
import { AlbumDetailView } from "../views/AlbumDetailView";
import { AlbumsView } from "../views/AlbumsView";
import { RouteErrorView } from "../views/NotFoundView";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
window.matchMedia ??=
  ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
Element.prototype.scrollTo ??= (() => {}) as typeof Element.prototype.scrollTo;

/** An openapi-fetch-shaped answer. */
const reply = (status: number, data?: unknown) => ({
  data: status < 400 ? data : undefined,
  error: status < 400 ? undefined : { detail: "boom" },
  response: new Response(null, { status }),
});

type Getter = (path: string) => ReturnType<typeof reply>;

function stubGet(impl: Getter) {
  return vi
    .spyOn(api, "GET")
    .mockImplementation(((path: string) => Promise.resolve(impl(path))) as never);
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("error states", () => {
  it("a 500 shows the error state (not a skeleton, not 0 albums) and Try Again refetches", async () => {
    let calls = 0;
    const get = stubGet((path) => {
      if (path !== "/api/albums") return reply(200, {});
      calls += 1;
      return calls === 1 ? reply(500) : reply(200, { items: [], total: 0 });
    });

    render(
      withQuery(
        <MemoryRouter initialEntries={["/albums"]}>
          <AlbumsView />
        </MemoryRouter>,
      ),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load albums");
    expect(screen.queryByText(/0 albums/)).toBeNull();
    expect(document.querySelector(".covergrid .loading-card")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByText("No albums yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(get.mock.calls.filter((args) => (args as unknown[])[0] === "/api/albums")).toHaveLength(2);
  });

  it("a detail 500 is an error, a 404 is 'not found' with a way back", async () => {
    stubGet((path) => (path === "/api/albums/{album_id}" ? reply(500) : reply(200, {})));
    const { unmount } = render(
      withQuery(
        <MemoryRouter initialEntries={["/albums/7"]}>
          <Routes>
            <Route path="/albums/:albumId" element={<AlbumDetailView />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load this album");
    expect(screen.queryByText("Album not found")).toBeNull();
    unmount();
    vi.restoreAllMocks();

    stubGet((path) => (path === "/api/albums/{album_id}" ? reply(404) : reply(200, {})));
    render(
      withQuery(
        <MemoryRouter initialEntries={["/albums/7"]}>
          <Routes>
            <Route path="/albums/:albumId" element={<AlbumDetailView />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Album not found" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Albums" })).toHaveAttribute(
      "href",
      "/albums",
    );
  });

  it("/nope renders the in-app 404 inside the shell", async () => {
    stubGet((path) => {
      if (path === "/api/auth/status") return reply(200, { enabled: false, authenticated: true });
      return reply(200, null);
    });
    const router = createMemoryRouter(routes, { initialEntries: ["/nope"] });
    render(withQuery(<RouterProvider router={router} />));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
    // The shell stays: the top bar's search is still there.
    expect(screen.getByRole("combobox", { name: "Search library" })).toBeInTheDocument();
  });

  it("a render error lands on the root error page, not the router's dev screen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): ReactNode {
      throw new Error("kaboom");
    }
    const router = createMemoryRouter([
      { path: "/", element: <Boom />, errorElement: <RouteErrorView /> },
    ]);
    render(<RouterProvider router={router} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });
});

describe("scan announcements", () => {
  it("speaks only the scan's edges", async () => {
    const { scanAnnouncement } = await import("../lib/announce");
    expect(scanAnnouncement("idle", "scanning", 0)).toBe("Library scan started.");
    expect(scanAnnouncement("scanning", "scanning", 0)).toBeNull();
    expect(scanAnnouncement("scanning", "idle", 0)).toBe("Library scan finished.");
    expect(scanAnnouncement("scanning", "idle", 2)).toBe(
      "Library scan finished. 2 files couldn’t be read.",
    );
  });
});
