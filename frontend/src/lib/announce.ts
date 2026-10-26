/* The screen-reader announcement channel. One store, read by the shell's
   always-mounted <Announcer> (components/Announcer.tsx); anything that
   wants to be heard calls `announce()`. */

import { create } from "zustand";

import { fmtCount } from "./format";

interface AnnouncerState {
  message: string;
  /** Bumped per announcement so the same sentence twice is re-read. */
  nonce: number;
  announce: (message: string) => void;
}

export const useAnnouncer = create<AnnouncerState>((set) => ({
  message: "",
  nonce: 0,
  announce: (message) => set((s) => ({ message, nonce: s.nonce + 1 })),
}));

/** Speak a short status sentence through the shell's live region. */
export function announce(message: string): void {
  useAnnouncer.getState().announce(message);
}

/** The scan sentences, by transition: only the edges speak, never a tick. */
export function scanAnnouncement(
  prev: "idle" | "scanning" | null,
  next: "idle" | "scanning",
  errors: number,
): string | null {
  if (prev !== "scanning" && next === "scanning") return "Library scan started.";
  if (prev === "scanning" && next === "idle") {
    return errors > 0
      ? `Library scan finished. ${fmtCount(errors)} ${errors === 1 ? "file" : "files"} couldn’t be read.`
      : "Library scan finished.";
  }
  return null;
}
