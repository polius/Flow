/* Row cursor: arrows move, Home/End and PageUp/PageDown jump, Enter
   activates the cursor row, and keys never fire while focus sits on an
   inner control. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRowCursor } from "../lib/rowCursor";

function Fixture({
  count,
  onActivate,
}: {
  count: number;
  onActivate: (index: number) => void;
}) {
  const { cursor, onKeyDown } = useRowCursor(count, onActivate);
  return (
    <div tabIndex={0} role="table" aria-label="Tracks" onKeyDown={onKeyDown}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role="row"
          className={cursor === i ? "cursor" : ""}
          data-rowindex={i}
        >
          row {i}
        </div>
      ))}
    </div>
  );
}

afterEach(cleanup);

describe("row cursor", () => {
  it("moves with the arrows, jumps with Home/End/PageUp/PageDown", () => {
    render(<Fixture count={60} onActivate={vi.fn()} />);
    const table = screen.getByRole("table");

    fireEvent.keyDown(table, { key: "ArrowDown" });
    expect(table.querySelector(".cursor")?.getAttribute("data-rowindex")).toBe("0");
    fireEvent.keyDown(table, { key: "ArrowDown" });
    fireEvent.keyDown(table, { key: "ArrowDown" });
    expect(table.querySelector(".cursor")?.getAttribute("data-rowindex")).toBe("2");
    fireEvent.keyDown(table, { key: "ArrowUp" });
    expect(table.querySelector(".cursor")?.getAttribute("data-rowindex")).toBe("1");

    fireEvent.keyDown(table, { key: "End" });
    expect(table.querySelector(".cursor")?.getAttribute("data-rowindex")).toBe("59");
    fireEvent.keyDown(table, { key: "PageUp" });
    expect(table.querySelector(".cursor")?.getAttribute("data-rowindex")).toBe("39");
    fireEvent.keyDown(table, { key: "Home" });
    expect(table.querySelector(".cursor")?.getAttribute("data-rowindex")).toBe("0");
    // ArrowUp at the top clamps, never wraps.
    fireEvent.keyDown(table, { key: "ArrowUp" });
    expect(table.querySelector(".cursor")?.getAttribute("data-rowindex")).toBe("0");
  });

  it("Enter activates the cursor row", () => {
    const activate = vi.fn();
    render(<Fixture count={5} onActivate={activate} />);
    const table = screen.getByRole("table");
    fireEvent.keyDown(table, { key: "ArrowDown" });
    fireEvent.keyDown(table, { key: "ArrowDown" });
    fireEvent.keyDown(table, { key: "Enter" });
    expect(activate).toHaveBeenCalledWith(1);
  });

  it("defers to inner controls, like the Organize grid guard", () => {
    const activate = vi.fn();
    render(<Fixture count={5} onActivate={activate} />);
    const table = screen.getByRole("table");
    // A focused button inside the table keeps its native keys.
    const button = document.createElement("button");
    table.appendChild(button);
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    fireEvent.keyDown(button, { key: "Enter" });
    expect(table.querySelector(".cursor")).toBeNull();
    expect(activate).not.toHaveBeenCalled();
  });
});
