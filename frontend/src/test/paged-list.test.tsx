/* Long lists are read at random access: the list is as long as the server
   says from the first answer, and a page is fetched when the window is
   over it — the end of the library is one scroll away. The A to Z rail
   jumps by the server's letter index. */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LetterRail } from "../components/LetterRail";
import { usePagedList } from "../lib/pagedList";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

afterEach(cleanup);

describe("usePagedList", () => {
  const TOTAL = 2590;
  const fetchPage = vi.fn((offset: number, limit: number) =>
    Promise.resolve({
      items: Array.from({ length: Math.min(limit, TOTAL - offset) }, (_, i) => offset + i),
      total: TOTAL,
    }),
  );

  it("is as long as the whole list after one page, with the rest as empty slots", async () => {
    fetchPage.mockClear();
    const { result } = renderHook(() => usePagedList(["albums", "x"], 500, fetchPage), { wrapper });
    expect(result.current.total).toBeUndefined();
    await waitFor(() => expect(result.current.total).toBe(TOTAL));
    expect(result.current.items).toHaveLength(TOTAL);
    expect(result.current.items[499]).toBe(499);
    expect(result.current.items[500]).toBeUndefined();
    expect(result.current.loaded).toBe(500);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("fetches the page under the window, wherever it is", async () => {
    fetchPage.mockClear();
    const { result } = renderHook(() => usePagedList(["albums", "y"], 500, fetchPage), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(TOTAL));

    act(() => result.current.ensure(2560, 2589)); // the last rows
    await waitFor(() => expect(result.current.items[2589]).toBe(2589));
    expect(fetchPage).toHaveBeenLastCalledWith(2500, 500);
    expect(fetchPage).toHaveBeenCalledTimes(2); // not the 4 pages in between
    expect(result.current.items[1000]).toBeUndefined();
    expect(result.current.loaded).toBe(590);

    // A window across a page boundary asks for both; asking again asks for nothing.
    act(() => result.current.ensure(990, 1010));
    await waitFor(() => expect(result.current.items[1010]).toBe(1010));
    act(() => result.current.ensure(990, 1010));
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it("starts over from the first page when the list changes", async () => {
    fetchPage.mockClear();
    const { result, rerender } = renderHook(
      ({ sort }) => usePagedList(["albums", sort], 500, fetchPage),
      { wrapper, initialProps: { sort: "title" } },
    );
    await waitFor(() => expect(result.current.total).toBe(TOTAL));
    act(() => result.current.ensure(2000, 2010));
    await waitFor(() => expect(result.current.items[2000]).toBe(2000));

    rerender({ sort: "year" });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.loaded).toBe(500));
    expect(result.current.items[2000]).toBeUndefined();
  });

  it("reports a first page that failed, not an empty list", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("500")));
    const { result } = renderHook(() => usePagedList(["albums", "z"], 500, failing), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.total).toBeUndefined();
  });
});

describe("letter rail", () => {
  const letters = [
    { letter: "#", index: 0 },
    { letter: "A", index: 3 },
    { letter: "M", index: 120 },
    { letter: "Z", index: 300 },
  ];
  const press = (name: string) => fireEvent.pointerDown(screen.getByRole("button", { name }));

  it("jumps to the first row of the pressed letter", () => {
    // jsdom has neither pointer capture nor hit testing.
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => true;
    document.elementFromPoint = () => null;
    const onJump = vi.fn();
    render(<LetterRail label="Songs" letters={letters} onJump={onJump} />);
    expect(screen.getByRole("navigation", { name: "Jump to a letter in Songs" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "M" }), { detail: 0 }); // keyboard
    expect(onJump).toHaveBeenLastCalledWith(120);
    fireEvent.click(screen.getByRole("button", { name: "Before A" }), { detail: 0 });
    expect(onJump).toHaveBeenLastCalledWith(0);
    // A letter the list does not have lands on the next one that it does.
    fireEvent.click(screen.getByRole("button", { name: "B" }), { detail: 0 });
    expect(onJump).toHaveBeenLastCalledWith(120);
    fireEvent.click(screen.getByRole("button", { name: "N" }), { detail: 0 });
    expect(onJump).toHaveBeenLastCalledWith(300);

    // The pointer path: a press on a letter.
    document.elementFromPoint = () => screen.getByRole("button", { name: "A" });
    press("A");
    expect(onJump).toHaveBeenLastCalledWith(3);
  });

  it("is not drawn when there is nothing to jump between", () => {
    const { container } = render(
      <LetterRail label="Songs" letters={[{ letter: "T", index: 0 }]} onJump={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
