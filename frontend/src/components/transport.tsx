/* Transport controls shared by the player bar and Now Playing so scrub
   behavior can't drift between them. */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { fmtDuration } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { IconPause, IconPlay } from "./icons";

export function Scrubber() {
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const buffered = usePlayerStore((s) => s.buffered);
  const seek = usePlayerStore((s) => s.seek);
  const [scrub, setScrub] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // Live seek: Music seeks under the thumb, not on release. Input events
  // coalesce through one rAF so a drag issues at most one seek per frame —
  // uncoalesced keyboard repeat or a burst of pointer events would stack
  // seeks the element must cancel.
  const pendingSeek = useRef<number | null>(null);
  const seekRaf = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const flushSeek = () => {
    seekRaf.current = null;
    if (pendingSeek.current != null) {
      seek(pendingSeek.current);
      pendingSeek.current = null;
    }
  };

  const cancelPendingSeek = () => {
    if (seekRaf.current != null) {
      cancelAnimationFrame(seekRaf.current);
      seekRaf.current = null;
    }
    pendingSeek.current = null;
  };

  useEffect(() => cancelPendingSeek, []);

  // Release: commit the position the user actually chose. The truth is the
  // element's own value, not the closure's — and the native `change` event
  // is the one release signal every browser fires (some touch browsers,
  // iOS Safari notably, never dispatch pointerup for a range drag, which
  // left `scrub` stuck and the position frozen at the drag point while the
  // audio played on). commit is idempotent; the duplicate paths (pointerup,
  // keyup, blur) only ever re-commit the same value.
  const commit = () => {
    cancelPendingSeek();
    const el = inputRef.current;
    if (el != null) {
      const final = Number(el.value);
      if (Number.isFinite(final)) seek(final);
    }
    setScrub(null);
    setDragging(false);
  };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = scrub ?? position;
  const max = duration || 0;
  const pct = (v: number) => (max > 0 ? Math.min(100, (v / max) * 100) : 0);

  const trackStyle = {
    // Longhand on purpose: the element's background *image* is the progress
    // fill; CSS is free to size that layer (the phone bar paints it as a
    // 3px hairline inside a taller touch target) without the shorthand
    // resetting background-size. --scrubber-rest keeps the empty rest track
    // visible in dark mode.
    backgroundImage: `linear-gradient(to right,
      var(--text-tertiary) 0% ${pct(value)}%,
      var(--control-border) ${pct(value)}% ${pct(buffered)}%,
      var(--scrubber-rest, var(--bg-active)) ${pct(buffered)}% 100%)`,
  };

  return (
    <>
      <span className="player__time">{fmtDuration(dragging ? scrub : position)}</span>
      <input
        ref={inputRef}
        type="range"
        className="range player__scrubber"
        style={trackStyle}
        min={0}
        max={max}
        step={1}
        value={Math.min(value, max)}
        disabled={max === 0}
        aria-label="Seek"
        onInput={(e) => {
          setDragging(true);
          const v = Number((e.target as HTMLInputElement).value);
          setScrub(v);
          pendingSeek.current = v;
          if (seekRaf.current == null) {
            seekRaf.current = requestAnimationFrame(flushSeek);
          }
        }}
        onPointerUp={commit}
        onPointerCancel={() => {
          // The system took the pointer mid-drag: release the visual hold
          // without committing a position the user didn't choose.
          cancelPendingSeek();
          setScrub(null);
          setDragging(false);
        }}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="player__time">{fmtDuration(duration)}</span>
    </>
  );
}

export function TransportButton({
  label,
  active,
  onClick,
  children,
  disabled,
  badge,
  primary,
  secondary,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  badge?: string;
  primary?: boolean;
  /** Mode switches (shuffle/repeat): hidden on the phone mini bar, still
      first-class in Now Playing. */
  secondary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`player__btn${active ? " player__btn--active" : ""}${
        primary ? " player__btn--play" : ""
      }${secondary ? " player__btn--secondary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
      {badge != null && <span className="player__badge">{badge}</span>}
    </button>
  );
}

/* Play/pause with a short glyph crossfade — the one motion that carries the
   play state. Both bars render this so it reads identically. */
export function PlayPauseButton({
  isPlaying,
  disabled,
}: {
  isPlaying: boolean;
  disabled?: boolean;
}) {
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  return (
    <TransportButton
      label={isPlaying ? "Pause" : "Play"}
      onClick={togglePlay}
      disabled={disabled}
      primary
    >
      <span className={`transport-glyph${isPlaying ? " transport-glyph--alt" : ""}`}>
        <span className="transport-glyph__pause">
          <IconPause size={19} />
        </span>
        <span className="transport-glyph__play">
          <IconPlay size={19} />
        </span>
      </span>
    </TransportButton>
  );
}
