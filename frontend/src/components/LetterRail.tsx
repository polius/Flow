/* The A to Z rail: a thin column of initials on the right edge of a list
   sorted by name. A press on a letter — or a drag along the rail — jumps
   the list to the first row that begins with it. Initials the list does
   not have are drawn dim and jump to the next one that it does. */

import { useRef } from "react";

import "../styles/rail.css";

export interface RailLetter {
  letter: string;
  index: number;
}

const RAIL = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

export function LetterRail({
  letters,
  onJump,
  label,
}: {
  /** The initials present in the list, with the row each starts at. */
  letters: RailLetter[];
  onJump: (index: number) => void;
  /** What the rail scrolls: "Songs", "Albums", "Artists". */
  label: string;
}) {
  const lastRef = useRef<string | null>(null);
  if (letters.length < 2) return null; // one initial: nothing to jump between

  const present = new Map(letters.map((l) => [l.letter, l.index]));
  // An absent initial lands on the next present one (or the last).
  const target = (letter: string): number => {
    for (let i = RAIL.indexOf(letter); i < RAIL.length; i++) {
      const index = present.get(RAIL[i]);
      if (index != null) return index;
    }
    return letters[letters.length - 1].index;
  };

  const go = (letter: string | null | undefined) => {
    if (letter == null || letter === lastRef.current) return;
    lastRef.current = letter;
    onJump(target(letter));
  };
  const letterAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-letter]")?.dataset.letter;

  return (
    <nav
      className="letterrail"
      aria-label={`Jump to a letter in ${label}`}
      // One gesture for mouse and touch: press, or press and slide.
      onPointerDown={(e) => {
        lastRef.current = null;
        e.currentTarget.setPointerCapture(e.pointerId);
        go(letterAt(e.clientX, e.clientY));
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0 && e.pointerType === "mouse") return;
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        go(letterAt(e.currentTarget.getBoundingClientRect().left + 4, e.clientY));
      }}
    >
      {RAIL.map((letter) => (
        <button
          key={letter}
          type="button"
          data-letter={letter}
          className={`letterrail__letter${present.has(letter) ? "" : " letterrail__letter--absent"}`}
          aria-label={letter === "#" ? "Before A" : letter}
          // Keyboard and assistive activation; the pointer path is above.
          onClick={(e) => {
            if (e.detail === 0) {
              lastRef.current = null;
              go(letter);
            }
          }}
        >
          {letter}
        </button>
      ))}
    </nav>
  );
}
