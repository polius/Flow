/* Full-screen Now Playing (§9.2): large art, blurred-artwork ambience on the
   same token system as album detail (§8.5, §13), full transport, and the
   queue panel on the right (§9.4). A takeover overlay rather than a route —
   the audio element lives outside React's lifecycle, so playback simply
   continues underneath. Esc closes (§9.5).

   §23: the two-zone layout is permanent — the stage shows a quiet idle
   state when nothing plays, and the queue (with its Add button) is present
   from the start, so a queue can be built before anything plays. Below
   940px, where the side-by-side drawer can't fit, the queue slides up over
   the stage as a sheet behind the header's queue button. */

import { useEffect, useState } from "react";

import { isTypingTarget } from "../lib/shortcuts";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Ambience } from "./Ambience";
import { Artwork } from "./Artwork";
import {
  IconChevronDown,
  IconMusicNote,
  IconNext,
  IconPrev,
  IconQueue,
  IconRepeat,
  IconShuffle,
  IconVolume,
} from "./icons";
import { QueuePanel } from "./QueuePanel";
import { PlayPauseButton, Scrubber, TransportButton } from "./transport";
import "../styles/nowplaying.css";

const NARROW_BP = "(max-width: 940px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

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

  const narrow = useMediaQuery(NARROW_BP);
  const [queueOpen, setQueueOpen] = useState(false);

  const handleClose = () => {
    setQueueOpen(false);
    close();
  };

  // Esc closes the takeover — but yields to whatever sits above it (§15.7):
  // the library picker, context menus, the Get Info panel, and inline edits
  // close first. Capture phase so this decision happens before the other
  // window listeners run. On narrow windows the queue sheet — the takeover's
  // own second layer — closes before the takeover itself.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ui = useUiStore.getState();
      if (ui.pickerOpen || ui.contextMenuOpen || ui.getInfoTrackId != null) return;
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      if (queueOpen) {
        setQueueOpen(false);
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close, queueOpen]);

  if (!open) return null;

  const classes = [
    "nowplaying",
    narrow && queueOpen ? "nowplaying--queue" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role="dialog" aria-modal="true" aria-label="Now Playing">
      <Ambience artworkId={track?.artwork_id ?? null} />

      <button
        type="button"
        className="nowplaying__close"
        onClick={handleClose}
        aria-label="Close Now Playing"
        title="Close (Esc)"
      >
        <IconChevronDown size={18} />
      </button>

      {narrow ? (
        <button
          type="button"
          className="nowplaying__queuebtn"
          onClick={() => setQueueOpen(true)}
          aria-haspopup="dialog"
          aria-controls="queue-panel"
          aria-expanded={queueOpen}
          title="Queue"
        >
          <IconQueue size={18} />
        </button>
      ) : null}

      <div className="nowplaying__layout">
        {track ? (
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
        ) : (
          <div className="nowplaying__stage">
            <div className="nowplaying__idle">
              <span className="nowplaying__idleart" aria-hidden="true">
                <IconMusicNote size={30} />
              </span>
              <h1 className="nowplaying__title">Nothing Playing</h1>
              <p className="nowplaying__hint">
                Add tracks to the queue, then tap one to start — or play an
                album or playlist anywhere in Flow.
              </p>
            </div>
          </div>
        )}

        <QueuePanel onCollapse={narrow ? () => setQueueOpen(false) : undefined} />
      </div>
    </div>
  );
}
