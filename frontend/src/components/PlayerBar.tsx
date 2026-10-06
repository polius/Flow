/* Translucent bottom player bar, persistent across views. The artwork
   thumb opens the full-screen Now Playing view. */

import { Link } from "react-router";

import type { Track } from "../api/types";
import { trackIsUnverified, useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import { FavoriteButton } from "./FavoriteButton";
import {
  IconNext,
  IconPrev,
  IconRepeat,
  IconShuffle,
} from "./icons";
import { PlayPauseButton, Scrubber, TransportButton } from "./transport";
import "../styles/player.css";

function TrackLine({ track }: { track: Track | null }) {
  if (!track) return <span className="player__title">Nothing playing</span>;
  // The bar links from restored state alone — a row the server
  // hasn't vouched for renders its names as text, not links into entities
  // that may not exist.
  const verified = !trackIsUnverified(track);
  return (
    <>
      <span className="player__title">
        {verified && track.album_id != null ? (
          // The title names the album it lives on when one exists —
          // text at rest, an underline on hover, nothing louder.
          <Link to={`/albums/${track.album_id}`}>{track.title}</Link>
        ) : (
          track.title
        )}
      </span>
      <span className="player__subtitle">
        {verified && track.artist_id != null ? (
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
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setShuffle = usePlayerStore((s) => s.setShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const openNowPlaying = useUiStore((s) => s.openNowPlaying);

  const hasQueue = track != null;

  return (
    <footer className={`player${hasQueue ? "" : " player--empty"}`}>
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
        {/* The playing song's favorite toggle, parked after the title with
            room to breathe. Bare by design: nothing in this bar wears a
            border, so the ring stayed in Now Playing — here the heart
            speaks in ink alone, and hover/loved raise the soft fills the
            bar already answers with. Hidden while nothing plays and while
            a restored session is unverified: no state change opens onto an
            id the server hasn't vouched for. */}
        {track != null && !trackIsUnverified(track) && (
          <FavoriteButton track={track} className="player__fav" size={16} />
        )}
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
    </footer>
  );
}
