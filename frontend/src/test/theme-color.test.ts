/* The browser's colour bar follows a manual theme (O2): Light or Dark
   points both theme-color tags at the chosen ramp; Auto gives each system
   scheme its own again. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme } from "../lib/theme";

const colors = () =>
  [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
    (m) => m.content,
  );

beforeEach(() => {
  document.head.innerHTML =
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f5f7">' +
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#161618">';
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

describe("the browser's colour bar", () => {
  it("follows a manual theme, and the system again on Auto", () => {
    applyTheme("dark");
    expect(colors()).toEqual(["#161618", "#161618"]);
    applyTheme("light");
    expect(colors()).toEqual(["#f5f5f7", "#f5f5f7"]);
    applyTheme("system");
    expect(colors()).toEqual(["#f5f5f7", "#161618"]);
  });
});
