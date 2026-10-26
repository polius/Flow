/* Artwork: thumbnails ask the server for the size they render at (CSS
   size × devicePixelRatio, snapped to the server's sizes), and one broken
   cover no longer hides every cover after it. */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Ambience } from "../components/Ambience";
import { Artwork } from "../components/Artwork";
import { artworkSize, artworkUrl } from "../lib/artwork";

afterEach(cleanup);

describe("artworkSize", () => {
  it("snaps CSS size × density up to the next server size", () => {
    expect(artworkSize(38, 1)).toBe(64);
    expect(artworkSize(38, 2)).toBe(96);
    expect(artworkSize(46, 2)).toBe(96);
    expect(artworkSize(56, 3)).toBe(256);
    expect(artworkSize(180, 2)).toBe(512);
  });

  it("asks for the original past the largest size", () => {
    expect(artworkSize(400, 2)).toBeNull();
    expect(artworkUrl(7, 400, 2)).toBe("/api/artwork/7");
    expect(artworkUrl(7, 38, 2)).toBe("/api/artwork/7?s=96");
    expect(artworkUrl(7)).toBe("/api/artwork/7");
  });
});

describe("Artwork", () => {
  it("a failed cover falls back for that id only", () => {
    const { container, rerender } = render(<Artwork artworkId={1} size={38} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull(); // placeholder

    rerender(<Artwork artworkId={2} size={38} />);
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/^\/api\/artwork\/2\?s=/);
  });

  it("the ambience gets its next chance too", () => {
    const { container, rerender } = render(<Ambience artworkId={1} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(<Ambience artworkId={2} />);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("large art is requested once, at its measured size", () => {
    const { container } = render(<Artwork artworkId={3} size={180} />);
    // jsdom lays nothing out: the measurement falls back to `size`.
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(
      /^\/api\/artwork\/3(\?s=\d+)?$/,
    );
  });
});
