/* The keyboard shortcut sheet: "?" anywhere lists every key the app
   answers to — the shortcuts existed, they just weren't discoverable. Also
   owns the two one-key verbs the sheet advertises ("/" search, "L" love
   the playing song), wired through lib/shortcuts' discovery block.

   A small modal on the app's dialog grammar: focus moves in, Tab stays
   inside, Esc / the scrim / "?" again close it, focus returns. While it is
   up it registers as a picker so the transport shortcuts and the other
   surfaces' Esc handlers defer to it. */

import { useCallback, useEffect, useRef, useState } from "react";

import { useToggleFavorite } from "../api/mutations";
import { useModalFocus } from "../lib/focus";
import { useDiscoveryShortcuts } from "../lib/shortcuts";
import { trackIsUnverified, useCurrentTrack } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { IconClose } from "./icons";
import "../styles/editing.css";
import "../styles/shortcuts.css";

const isApple =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const MOD = isApple ? "⌘" : "Ctrl";
const ALT = isApple ? "⌥" : "Alt";

/** One row: the keys (alternatives separated by "or") and what they do. */
interface Row {
  keys: string[][];
  does: string;
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Playback",
    rows: [
      { keys: [["Space"]], does: "Play or pause" },
      { keys: [["←"], ["→"]], does: "Skip back or ahead 10 seconds" },
      { keys: [[MOD, "→"]], does: "Next song" },
      { keys: [[MOD, "←"]], does: "Previous song" },
      { keys: [["L"]], does: "Love or unlove the playing song" },
    ],
  },
  {
    title: "Anywhere",
    rows: [
      { keys: [["/"], [MOD, "F"]], does: "Search your library" },
      { keys: [["?"]], does: "Show this list" },
      { keys: [["Esc"]], does: "Close the menu, panel or dialog on top" },
    ],
  },
  {
    title: "Song lists",
    rows: [
      { keys: [["↑"], ["↓"]], does: "Move between songs" },
      { keys: [["Home"], ["End"]], does: "First or last song" },
      { keys: [["Page Up"], ["Page Down"]], does: "Jump 20 songs" },
      { keys: [["Enter"]], does: "Play the song" },
      { keys: [["Shift", "F10"], ["Menu"]], does: "Song actions" },
      {
        keys: [[ALT, "↑"], [ALT, "↓"]],
        does: "Move the song (playlists, albums, Favorites, Up Next)",
      },
      { keys: [[MOD, "Click"], ["Shift", "Click"]], does: "Select several songs" },
    ],
  },
];

export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  const current = useCurrentTrack();
  const toggleFavorite = useToggleFavorite();

  const toggleHelp = useCallback(() => setOpen((o) => !o), []);
  const loveCurrent = useCallback(() => {
    // An unverified restored row isn't vouched for by the server yet —
    // the player bar hides its heart for the same reason.
    if (current && !trackIsUnverified(current)) toggleFavorite(current);
  }, [current, toggleFavorite]);

  useDiscoveryShortcuts({ helpOpen: open, toggleHelp, toggleFavorite: loveCurrent });

  if (!open) return null;
  return <SheetDialog onClose={() => setOpen(false)} />;
}

function SheetDialog({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, true);

  // Registered like the other dialogs: Esc closes, and the global
  // shortcuts / other surfaces defer while it is up.
  useEffect(() => {
    useUiStore.getState().setPickerOpen(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      useUiStore.getState().setPickerOpen(false);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <>
      <div className="addtracks__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
      >
        <header className="shortcuts__head">
          <h2 className="shortcuts__title" id="shortcuts-title">
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            className="shortcuts__close"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={14} />
          </button>
        </header>
        <div className="shortcuts__body">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcuts__group">
              <h3 className="shortcuts__grouptitle">{group.title}</h3>
              <dl className="shortcuts__list">
                {group.rows.map((row) => (
                  <div key={row.does} className="shortcuts__row">
                    <dt className="shortcuts__keys">
                      {row.keys.map((combo, i) => (
                        <span key={combo.join("+")} className="shortcuts__combo">
                          {i > 0 && <span className="shortcuts__or">or</span>}
                          {combo.map((k) => (
                            <kbd key={k} className="shortcuts__kbd">
                              {k}
                            </kbd>
                          ))}
                        </span>
                      ))}
                    </dt>
                    <dd className="shortcuts__does">{row.does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
