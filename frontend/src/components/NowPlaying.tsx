/* Full-screen Now Playing (§9.2): large art, blurred-artwork ambience on the
   same token system as album detail (§8.5, §13), full transport, and the
   queue drawer on the right (§9.4). A takeover overlay rather than a route —
   the audio element lives outside the view lifecycle, so playback simply
   continues underneath. Esc closes (§9.5). */

import { useEffect } from "react";

import { isTypingTarget } from "../lib/shortcuts";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Ambience } from "./Ambience";
import { Artwork } from "./Artwork";
import { EmptyState } from "./EmptyState";
import {
  IconChevronDown,
  IconMusicNote,
  IconNext,
  IconPrev,
  IconRepeat,
  IconShuffle,
  IconVolume,
} from "./icons";
import { QueuePanel } from "./QueuePanel";
import { PlayPauseButton, Scrubber, TransportButton } from "./transport";
import "../styles/nowplaying.css";

export function NowPlaying() {
  const open = useUiStore((s) => s.nowPlayingOpen);
  const close = useUiStore((s) => s.closeNowPlaying);
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

  // Esc closes the takeover — but yields to whatever sits above it (§15.7):
  // context menus, the Get Info panel, and inline edits close first. Capture
  // phase so this decision happens before the other window listeners run.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ui = useUiStore.getState();
      if (ui.contextMenuOpen || ui.getInfoTrackId != null) return;
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="nowplaying" role="dialog" aria-modal="true" aria-label="Now Playing">
      <Ambience artworkId={track?.artwork_id ?? null} />

      <button
        type="button"
        className="nowplaying__close"
        onClick={close}
        aria-label="Close Now Playing"
        title="Close (Esc)"
      >
        <IconChevronDown size={18} />
      </button>

      {track ? (
        <div className="nowplaying__layout">
          <div className="nowplaying__stage">
            <Artwork
              artworkId={track.artwork_id}
              size={400}
              radius="l"
              className="nowplaying__art"
            />
            <div className="nowplaying__meta">
              <h1 className="nowplaying__title">{track.title}</h1>
              <p className="nowplaying__artist">{track.artist ?? " "}</p>
              {track.album != null && (
                <p className="nowplaying__album">{track.album}</p>
              )}
            </div>
            <div className="nowplaying__controls">
              <div className="nowplaying__transport">
                <TransportButton
                  label="Shuffle"
                  active={shuffle}
                  onClick={() => setShuffle(!shuffle)}
                >
                  <IconShuffle size={16} />
                </TransportButton>
                <TransportButton label="Previous track" onClick={prev}>
                  <IconPrev size={19} />
                </TransportButton>
                <PlayPauseButton isPlaying={isPlaying} />
                <TransportButton label="Next track" onClick={next}>
                  <IconNext size={19} />
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
              <div className="nowplaying__progress">
                <Scrubber />
              </div>
              <div className="nowplaying__volume">
                <IconVolume size={15} />
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
            </div>
          </div>

          <QueuePanel />
        </div>
      ) : (
        <div className="nowplaying__stage">
          <EmptyState
            icon={<IconMusicNote size={26} />}
            title="Nothing playing"
            hint="Double-click any track to start — the queue and full-screen view follow along."
          />
        </div>
      )}
    </div>
  );
}
