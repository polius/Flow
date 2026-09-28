/* Bottom player bar — persistent, translucent (DESIGN.md §9.1, §8.5).
   Milestone 1: honest empty state; transport activates in Milestone 3. */

import { IconMusicNote, IconNext, IconPlay, IconPrev, IconRepeat, IconShuffle, IconVolume } from "./icons";
import { usePlayerStore } from "../stores/player";
import "../styles/player.css";

export function PlayerBar() {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);

  return (
    <footer className="player">
      <div className="player__meta">
        <div className="player__artwork" aria-hidden="true">
          <IconMusicNote size={20} />
        </div>
        <div className="player__titles">
          <span className="player__title">Nothing playing</span>
        </div>
      </div>

      <div className="player__center">
        <div className="player__transport">
          <button type="button" className="player__btn" disabled aria-label="Shuffle" title="Shuffle">
            <IconShuffle size={16} />
          </button>
          <button type="button" className="player__btn" disabled aria-label="Previous track" title="Previous">
            <IconPrev size={17} />
          </button>
          <button type="button" className="player__btn player__btn--play" disabled aria-label="Play" title="Play">
            <IconPlay size={19} />
          </button>
          <button type="button" className="player__btn" disabled aria-label="Next track" title="Next">
            <IconNext size={17} />
          </button>
          <button type="button" className="player__btn" disabled aria-label="Repeat" title="Repeat">
            <IconRepeat size={16} />
          </button>
        </div>
        <div className="player__progress">
          <span className="player__time">–:––</span>
          <input
            type="range"
            className="range"
            min={0}
            max={100}
            value={0}
            disabled
            aria-label="Seek"
          />
          <span className="player__time">–:––</span>
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
