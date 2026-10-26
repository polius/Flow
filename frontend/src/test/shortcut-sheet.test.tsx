/* The shortcut sheet and its one-key verbs (audit product gap): "?" opens
   a modal list of every shortcut and "?" / Esc close it with focus
   returned; "/" focuses search; "L" loves the playing song. Letters never
   fire while text is being edited. Plus the Settings controls' semantics
   (D12 switch name, D19 theme radiogroup arrows) and the login form's
   password-manager and error wiring (D19). */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type * as Mutations from "../api/mutations";

const favorite = vi.hoisted(() => vi.fn());
vi.mock("../api/mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof Mutations>()),
  useToggleFavorite: () => favorite,
}));
vi.mock("../api/queue", () => ({
  fetchServerQueue: vi.fn().mockResolvedValue({ status: "empty" }),
  saveServerQueue: vi.fn(),
  saveServerPlayhead: vi.fn(),
  playByFilter: vi.fn(),
}));

import { api } from "../api/client";
import type { Track } from "../api/types";
import { ShortcutSheet } from "../components/ShortcutSheet";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { LoginView } from "../views/LoginView";
import { SettingsView } from "../views/SettingsView";

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

const TRACK: Track = {
  id: 1,
  title: "Afterglow",
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
  track_no: 1,
  disc_no: 1,
  year: 2026,
  duration: 180,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: "Artist/Album/Afterglow.mp3",
  gain_db: null,
  played_at: null,
};

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  favorite.mockReset();
  usePlayerStore.setState({ queue: [TRACK], order: [0], orderPos: 0 });
  useUiStore.setState({ pickerOpen: false, contextMenuOpen: false, searchFocusSignal: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("shortcut sheet", () => {
  it("? opens a modal list; Esc closes it and focus returns", () => {
    render(wrap(<ShortcutSheet />));
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    fireEvent.keyDown(window, { key: "?" });
    const dialog = screen.getByRole("dialog", { name: "Keyboard Shortcuts" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByText("Love or unlove the playing song")).toBeInTheDocument();
    // While it is up it owns the keyboard like any picker.
    expect(useUiStore.getState().pickerOpen).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("? toggles; another open modal keeps the key", () => {
    render(wrap(<ShortcutSheet />));
    fireEvent.keyDown(window, { key: "?" });
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByRole("dialog")).toBeNull();

    useUiStore.setState({ pickerOpen: true });
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("/ focuses search and L loves the playing song — never while typing", () => {
    render(wrap(<ShortcutSheet />));
    fireEvent.keyDown(window, { key: "/" });
    expect(useUiStore.getState().searchFocusSignal).toBe(1);

    fireEvent.keyDown(window, { key: "l" });
    expect(favorite).toHaveBeenCalledWith(TRACK);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "l" });
    fireEvent.keyDown(input, { key: "/" });
    expect(favorite).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().searchFocusSignal).toBe(1);
    input.remove();

    // A modifier chord is someone else's shortcut.
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    expect(favorite).toHaveBeenCalledTimes(1);
  });
});

describe("login form", () => {
  it("files the credential under a fixed username and links the error to the field", async () => {
    vi.spyOn(api, "GET").mockImplementation(() =>
      Promise.resolve({
        data: { enabled: true, authenticated: false },
        response: new Response(null, { status: 200 }),
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "no" }), { status: 401 })),
    );
    const { container } = render(wrap(<LoginView />));
    const password = await screen.findByLabelText("Password");
    const username = container.querySelector<HTMLInputElement>("input[autocomplete=username]");
    expect(username).not.toBeNull();
    expect(username).toHaveAttribute("tabindex", "-1");
    expect(password).not.toHaveAttribute("aria-describedby");

    fireEvent.change(password, { target: { value: "wrong" } });
    fireEvent.submit(password.closest("form")!);
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Incorrect password");
    expect(password).toHaveAttribute("aria-describedby", error.id);
    vi.unstubAllGlobals();
  });
});

describe("settings controls", () => {
  beforeEach(() => {
    vi.spyOn(api, "GET").mockImplementation(() =>
      Promise.resolve({ data: undefined, response: new Response(null, { status: 200 }) }),
    );
  });

  it("the normalize switch is named by its row, not by On/Off", () => {
    render(wrap(<SettingsView />));
    const sw = screen.queryByRole("switch", { name: "Normalize volume" });
    // iOS hides the row entirely; jsdom is not iOS.
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAccessibleDescription(/Balances soft and loud songs/);
  });

  it("the theme radiogroup is one Tab stop and the arrows choose", () => {
    useUiStore.setState({ themeMode: "system" });
    render(wrap(<SettingsView />));
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0].focus();
    act(() => {
      fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    });
    expect(useUiStore.getState().themeMode).toBe("light");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Light" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(useUiStore.getState().themeMode).toBe("dark");
  });
});
