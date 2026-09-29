/* Transport controls shared by the player bar and Now Playing (§9.1, §9.2).
   Moved out of PlayerBar in M5 so the full-screen view drives the same
   engine with the same scrub behavior. */

import { useState, type ReactNode } from "react";

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

  const value = scrub ?? position;
  const max = duration || 0;
  const pct = (v: number) => (max > 0 ? Math.min(100, (v / max) * 100) : 0);

  const trackStyle = {
    background: `linear-gradient(to right,
      var(--text-tertiary) 0% ${pct(value)}%,
      var(--control-border) ${pct(value)}% ${pct(buffered)}%,
      var(--bg-active) ${pct(buffered)}% 100%)`,
  };

  const commit = () => {
    if (scrub != null) {
      seek(scrub);
      setScrub(null);
    }
    setDragging(false);
  };

  return (
    <>
      <span className="player__time">{fmtDuration(dragging ? scrub : position)}</span>
      <input
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
          setScrub(Number((e.target as HTMLInputElement).value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => {
          setScrub(null);
          setDragging(false);
        }}
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
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  badge?: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`player__btn${active ? " player__btn--active" : ""}${
        primary ? " player__btn--play" : ""
      }`}
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
   play state (§8.4). Both bars render this so the state reads identically. */
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
