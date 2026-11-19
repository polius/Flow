/* Translucent bottom player bar, persistent across views. The right
   column holds the sleep timer, the queue, the volume and the door to
   the full-screen Now Playing view, which the artwork thumb also opens. */

import { Link } from "react-router";

import type { Track } from "../api/types";
import { useMediaQuery } from "../lib/media";
import { isIOS } from "../lib/platform";
import { trackIsUnverified, useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Artwork } from "./Artwork";
import { FavoriteButton } from "./FavoriteButton";
import { IconChevronUp, IconNext, IconPrev, IconQueue, IconRepeat, IconShuffle } from "./icons";
import { SleepTimer } from "./SleepTimer";
import { MOD_KEY } from "../lib/platform";
import { PlayPauseButton, Scrubber, TransportButton, VolumeControl } from "./transport";
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
  const openQueue = useUiStore((s) => s.openQueue);

  // The phone mini player is a 60px row: its cover is 40px, not 46.
  const phone = useMediaQuery("(max-width: 640px)");

  const hasQueue = track != null;

  return (
    <footer className={`player${hasQueue ? "" : " player--empty"}`}>
      <div className="player__meta">
        <button
          type="button"
          className="player__art"
          onClick={openNowPlaying}
          aria-label="Open Now Playing"
          title="Now Playing (N)"
        >
          <Artwork artworkId={track?.artwork_id ?? null} size={phone ? 40 : 46} />
        </button>
        <div className="player__titles">
          <TrackLine track={track} />
        </div>
        {/* The playing song's favorite toggle, after the title. Bare —
            nothing in this bar wears a border. Hidden while nothing plays
            or the session is unverified. */}
        {track != null && !trackIsUnverified(track) && (
          <FavoriteButton track={track} className="player__fav" size={16} />
        )}
      </div>

      <div className="player__center">
        <div className="player__transport">
          <TransportButton
            label="Shuffle"
            hint="S"
            active={shuffle}
            secondary
            onClick={() => setShuffle(!shuffle)}
          >
            <IconShuffle size={16} />
          </TransportButton>
          <TransportButton
            label="Previous song"
            hint={`${MOD_KEY}←`}
            onClick={prev}
            disabled={!hasQueue}
          >
            <IconPrev size={17} />
          </TransportButton>
          <PlayPauseButton isPlaying={isPlaying} disabled={!hasQueue} />
          <TransportButton
            label="Next song"
            hint={`${MOD_KEY}→`}
            onClick={next}
            disabled={!hasQueue}
          >
            <IconNext size={17} />
          </TransportButton>
          <TransportButton
            label={`Repeat: ${repeat}`}
            hint="R"
            active={repeat !== "off"}
            badge={repeat === "one" ? "1" : undefined}
            secondary
            onClick={cycleRepeat}
          >
            <IconRepeat size={16} />
          </TransportButton>
        </div>
        {/* The no-op click makes this strip a tap target in its own right.
            On the phone mini bar it is an inert 24px band along the bar's
            top edge (player.css): without a handler of its own, phone
            browsers pass a tap that lands on it to the nearest element
            that has one — the song row peeking out above the bar. */}
        <div className="player__progress" onClick={() => {}}>
          <Scrubber />
        </div>
      </div>

      {/* The right column. Everything here also lives in Now Playing,
          so the phone mini bar drops the whole group. */}
      <div className="player__side">
        <SleepTimer compact />
        <TransportButton label="Queue" hint="Q" secondary onClick={openQueue}>
          <IconQueue size={17} />
        </TransportButton>
        {!isIOS && <VolumeControl />}
        <TransportButton label="Open Now Playing" hint="N" secondary onClick={openNowPlaying}>
          <IconChevronUp size={17} />
        </TransportButton>
      </div>
    </footer>
  );
}
