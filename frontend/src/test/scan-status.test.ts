/* The scan status line: every phase speaks its own verb and its live counts
   (the analyze pass's blind "Analyzing audio…" label is the regression
   pinned here). scanProgressFraction feeds the TopBar's determinate ring;
   null keeps the spinner. */

import { describe, expect, it } from "vitest";

import {
  scanProgressFraction,
  scanStatusLabel,
} from "../lib/format";

/* The suite's Node resolves `Intl.NumberFormat` without grouping; the
   browser groups ("1,204"). The label's contract is verb + both counts —
   the rendered grouping is the runtime locale's business (verified live:
   "812/1,204"). */
const n = (v: number) => new Intl.NumberFormat().format(v);

describe("scanStatusLabel", () => {
  it("counts the loudness pass like the index scan", () => {
    expect(scanStatusLabel({ phase: "analyze", current: 34, total: 1204 })).toBe(
      `Analyzing audio… ${n(34)}/${n(1204)}`,
    );
  });

  it("omits the analyze counts while the total isn't known", () => {
    expect(scanStatusLabel({ phase: "analyze", current: 0, total: 0 })).toBe(
      "Analyzing audio…",
    );
  });

  it("keeps the scan phase's counts", () => {
    expect(scanStatusLabel({ phase: "scan", current: 342, total: 1204 })).toBe(
      `Scanning… ${n(342)}/${n(1204)}`,
    );
    expect(scanStatusLabel({ phase: null, current: 0, total: 0 })).toBe("Scanning…");
  });

  it("the watcher's quick updates stay count-less", () => {
    expect(scanStatusLabel({ phase: "watch", current: 3, total: 9 })).toBe("Updating…");
  });
});

describe("scanProgressFraction", () => {
  it("resolves the fraction when the phase counts files", () => {
    expect(scanProgressFraction({ phase: "analyze", current: 602, total: 1204 })).toBeCloseTo(
      0.5,
    );
    expect(scanProgressFraction({ phase: "scan", current: 1204, total: 1204 })).toBe(1);
  });

  it("stays null for the spinner's phases — total-less or watch", () => {
    expect(scanProgressFraction({ phase: "analyze", current: 5, total: 0 })).toBeNull();
    expect(scanProgressFraction({ phase: "watch", current: 3, total: 9 })).toBeNull();
  });

  it("clamps a fraction that races past its total", () => {
    expect(scanProgressFraction({ phase: "scan", current: 1300, total: 1204 })).toBe(1);
  });
});
