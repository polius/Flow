/* Bottom player bar — persistent, translucent (DESIGN.md §9.1, §8.5).
   Working transport: queue-aware play/pause/next/prev, scrubbing with
   buffered-range indication, shuffle/repeat, persisted volume.
   M5: the artwork thumb opens the full-screen Now Playing view (§9.2). */

import { Link } from "react-router";

import type { Track } from "../api/types";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import {
  IconNext,
  IconPrev,
  IconRepeat,
  IconShuffle,
  IconVolume,
} from "./icons";
import { PlayPauseButton, Scrubber, TransportButton } from "./transport";
import "../styles/player.css";

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
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setShuffle = usePlayerStore((s) => s.setShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const openNowPlaying = useUiStore((s) => s.openNowPlaying);

  const hasQueue = track != null;

  return (
    <footer className="player">
      <div className="player__meta">
        <button
          type="button"
          className="player__art"
          onClick={openNowPlaying}
          aria-label="Open Now Playing"
          title="Now Playing"
        >
          <Artwork artworkId={track?.artwork_id ?? null} size={46} />
        </button>
        <div className="player__titles">
          <TrackLine track={track} />
        </div>
      </div>

      <div className="player__center">
        <div className="player__transport">
          <TransportButton
            label="Shuffle"
            active={shuffle}
            secondary
            onClick={() => setShuffle(!shuffle)}
          >
            <IconShuffle size={16} />
          </TransportButton>
          <TransportButton label="Previous track" onClick={prev} disabled={!hasQueue}>
            <IconPrev size={17} />
          </TransportButton>
          <PlayPauseButton isPlaying={isPlaying} disabled={!hasQueue} />
          <TransportButton label="Next track" onClick={next} disabled={!hasQueue}>
            <IconNext size={17} />
          </TransportButton>
          <TransportButton
            label={`Repeat: ${repeat}`}
            active={repeat !== "off"}
            badge={repeat === "one" ? "1" : undefined}
            secondary
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
