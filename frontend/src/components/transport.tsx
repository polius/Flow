/* Transport controls shared by the player bar and Now Playing so scrub
   behavior can't drift between them. */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { fmtDuration } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { IconPause, IconPlay, IconVolume, IconVolumeMute } from "./icons";

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

  const commit = () => {
    cancelPendingSeek();
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
          const v = Number((e.target as HTMLInputElement).value);
          setScrub(v);
          pendingSeek.current = v;
          if (seekRaf.current == null) {
            seekRaf.current = requestAnimationFrame(flushSeek);
          }
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => {
          cancelPendingSeek();
          setScrub(null);
          setDragging(false);
        }}
      />
      <span className="player__time">{fmtDuration(duration)}</span>
    </>
  );
}

/* Volume with click-to-mute: muted (or at zero) shows the muted glyph;
   moving the slider unmutes. */
export function VolumeControl({ size = 16 }: { size?: number }) {
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);

  const silent = muted || volume === 0;
  return (
    <>
      <button
        type="button"
        className="volumebtn"
        aria-label={silent ? "Unmute" : "Mute"}
        aria-pressed={silent}
        title={silent ? "Unmute" : "Mute"}
        onClick={toggleMute}
      >
        {silent ? <IconVolumeMute size={size} /> : <IconVolume size={size} />}
      </button>
      <input
        type="range"
        className="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        aria-label="Volume"
      />
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
