/* Sleep timer: a pill in Now Playing's action row, and a moon button in
   the player bar (`compact`), that open the same small menu —
   15/30/45/60 minutes, or the end of the current track. While a timer
   runs the pill counts down and the moon wears the active mark; picking
   "Turn Off Timer" cancels it. The timer itself lives in the player
   store (it must outlive either view). */

import { useEffect, useRef, useState } from "react";

import { fmtDuration } from "../lib/format";
import { usePlayerStore, type SleepTimer as SleepTimerState } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { IconCheck, IconMoon } from "./icons";

const MINUTE_CHOICES = [15, 30, 45, 60];

/** Seconds left on a running minutes timer, ticking once a second. */
function useSecondsLeft(sleep: SleepTimerState | null): number | null {
  const endsAt = sleep?.kind === "minutes" ? sleep.endsAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt == null) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0); // a fresh timer reads right away
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [endsAt]);
  return endsAt == null ? null : Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export function SleepTimer({ compact = false }: { compact?: boolean }) {
  const sleep = usePlayerStore((s) => s.sleep);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const secondsLeft = useSecondsLeft(sleep);

  // Menu lifecycle: outside tap, Esc. Registered like every other menu —
  // contextMenuOpen makes Now Playing's Esc and the global shortcuts
  // yield to it while it is up.
  useEffect(() => {
    if (!open) return;
    useUiStore.getState().setContextMenuOpen(true);
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      useUiStore.getState().setContextMenuOpen(false);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = (choice: number | "track" | null) => {
    setSleepTimer(choice);
    setOpen(false);
  };

  const label =
    sleep == null
      ? "Sleep Timer"
      : sleep.kind === "track"
        ? "Sleep: End of Song"
        : `Sleep: ${fmtDuration(secondsLeft ?? 0)}`;

  return (
    <div className={`nowplaying__sleep${compact ? " nowplaying__sleep--bar" : ""}`} ref={wrapRef}>
      {compact ? (
        <button
          type="button"
          className={`player__btn player__btn--secondary${sleep != null ? " player__btn--active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          title={label}
          onClick={() => setOpen((o) => !o)}
        >
          <IconMoon size={16} />
        </button>
      ) : (
        <button
          type="button"
          className={`nowplaying__addto nowplaying__sleepbtn${sleep != null ? " nowplaying__addto--on" : " nowplaying__iconpill"}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((o) => !o)}
        >
          <IconMoon size={13} />
          {/* On a phone an idle timer is a moon in a circle, like the
              favorite beside it, and a running one drops the "Sleep:"
              prefix (nowplaying.css): the row then fits on one line. */}
          {sleep == null ? (
            <span className="nowplaying__pilltext">{label}</span>
          ) : (
            <span>
              <span className="nowplaying__sleepprefix">Sleep: </span>
              {sleep.kind === "track" ? "End of Song" : fmtDuration(secondsLeft ?? 0)}
            </span>
          )}
        </button>
      )}
      {open && (
        <div className="trackmenu nowplaying__sleepmenu" role="menu" aria-label="Sleep timer">
          {MINUTE_CHOICES.map((m) => {
            const checked = sleep?.kind === "minutes" && sleep.minutes === m;
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className="trackmenu__item"
                onClick={() => pick(m)}
              >
                <span className="trackmenu__check" aria-hidden="true">
                  {checked && <IconCheck size={13} />}
                </span>
                {m} minutes
              </button>
            );
          })}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={sleep?.kind === "track"}
            className="trackmenu__item"
            onClick={() => pick("track")}
          >
            <span className="trackmenu__check" aria-hidden="true">
              {sleep?.kind === "track" && <IconCheck size={13} />}
            </span>
            End of song
          </button>
          {sleep != null && (
            <button
              type="button"
              role="menuitem"
              className="trackmenu__item"
              onClick={() => pick(null)}
            >
              <span className="trackmenu__check" aria-hidden="true" />
              Turn Off Timer
            </button>
          )}
        </div>
      )}
    </div>
  );
}
