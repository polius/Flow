/* Bottom player bar — persistent, translucent (DESIGN.md §9.1, §8.5).
   Working transport: queue-aware play/pause/next/prev, scrubbing with
   buffered-range indication, shuffle/repeat, persisted volume. */

import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import type { Track } from "../api/types";
import { fmtDuration } from "../lib/format";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { Artwork } from "./Artwork";
import {
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconRepeat,
  IconShuffle,
  IconVolume,
} from "./icons";
import "../styles/player.css";

function Scrubber() {
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

function TransportButton({
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

function TrackLine({ track }: { track: Track | null }) {
  if (!track) return <span className="player__title">Nothing playing</span>;
  return (
    <>
      <span className="player__title">{track.title}</span>
      <span className="player__subtitle">
        {track.artist_id != null ? (
          <Link to={`/artists/${track.artist_id}`}>{track.artist}</Link>
        ) : (
          track.artist ?? " "
        )}
      </span>
    </>
  );
}

export function PlayerBar() {
  const track = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setShuffle = usePlayerStore((s) => s.setShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);

  const hasQueue = track != null;

  return (
    <footer className="player">
      <div className="player__meta">
        <Artwork artworkId={track?.artwork_id ?? null} size={46} />
        <div className="player__titles">
          <TrackLine track={track} />
        </div>
      </div>

      <div className="player__center">
        <div className="player__transport">
          <TransportButton
            label="Shuffle"
            active={shuffle}
            onClick={() => setShuffle(!shuffle)}
          >
            <IconShuffle size={16} />
          </TransportButton>
          <TransportButton label="Previous track" onClick={prev} disabled={!hasQueue}>
            <IconPrev size={17} />
          </TransportButton>
          <TransportButton
            label={isPlaying ? "Pause" : "Play"}
            onClick={togglePlay}
            disabled={!hasQueue}
            primary
          >
            {isPlaying ? <IconPause size={19} /> : <IconPlay size={19} />}
          </TransportButton>
          <TransportButton label="Next track" onClick={next} disabled={!hasQueue}>
            <IconNext size={17} />
          </TransportButton>
          <TransportButton
            label={`Repeat: ${repeat}`}
            active={repeat !== "off"}
            badge={repeat === "one" ? "1" : undefined}
            onClick={cycleRepeat}
          >
            <IconRepeat size={16} />
          </TransportButton>
        </div>
        <div className="player__progress">
          <Scrubber />
        </div>
      </div>

      <div className="player__volume">
        <IconVolume size={16} />
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
      </div>
    </footer>
  );
}
