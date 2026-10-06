/* Full-screen Now Playing: large art, blurred-artwork ambience, full
   transport, and the queue panel. A takeover overlay rather than a route —
   the audio element lives outside React's lifecycle, so playback simply
   continues underneath. The two-zone layout is permanent: the stage shows
   a quiet idle state when nothing plays, and the queue is present from the
   start. Below 940px the queue slides up over the stage as a sheet. */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { useMediaQuery } from "../lib/media";
import { isTextEditingTarget } from "../lib/shortcuts";
import { trackIsUnverified, useCurrentTrack, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";
import { Ambience } from "./Ambience";
import { Artwork } from "./Artwork";
import { FavoriteButton } from "./FavoriteButton";
import {
  IconChevronDown,
  IconMusicNote,
  IconNext,
  IconPlaylistAdd,
  IconPrev,
  IconQueue,
  IconRepeat,
  IconShuffle,
} from "./icons";
import { QueuePanel } from "./QueuePanel";
import { PlayPauseButton, Scrubber, TransportButton } from "./transport";
import { useModalFocus } from "../lib/focus";
import "../styles/nowplaying.css";

const NARROW_BP = "(max-width: 940px)";

export function NowPlaying() {
  const open = useUiStore((s) => s.nowPlayingOpen);
  const close = useUiStore((s) => s.closeNowPlaying);
  const openAddToPlaylist = useUiStore((s) => s.openAddToPlaylist);
  const track = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const origin = usePlayerStore((s) => s.origin);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setShuffle = usePlayerStore((s) => s.setShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);

  const narrow = useMediaQuery(NARROW_BP);
  const [queueOpen, setQueueOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Modal focus: focus moves into the takeover on open, Tab cycles
  // inside it, and closing restores focus to whatever opened it.
  useModalFocus(surfaceRef, open);

  const handleClose = () => {
    setQueueOpen(false);
    close();
  };

  // Esc closes the takeover — but yields to whatever sits above it:
  // the library picker, context menus, the Get Info panel, and queue drags
  // close first. Capture phase so this decision happens before the other
  // window listeners run. On narrow windows the queue sheet — the takeover's
  // own second layer — closes before the takeover itself. Focus in text
  // mid-edit defers (Esc cancels the edit there); a focused button or link
  // never blocks the close.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ui = useUiStore.getState();
      if (ui.pickerOpen || ui.contextMenuOpen || ui.getInfoTrackId != null || ui.queueDragOpen)
        return;
      if (isTextEditingTarget(document.activeElement)) return;
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

  // The takeover renders names from restored state alone. Until the
  // server has vouched for the session, they read as text — a stale
  // snapshot's ids may name entities that no longer exist.
  const verified = !trackIsUnverified(track);

  const classes = [
    "nowplaying",
    narrow && queueOpen ? "nowplaying--queue" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={surfaceRef}
      className={classes}
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
    >
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
              <p className="nowplaying__artist">
                {verified && track.artist_id != null && track.artist ? (
                  // Every name on a listening surface is a link —
                  // styled as today's text, an underline on hover only.
                  <Link
                    to={`/artists/${track.artist_id}`}
                    className="nowplaying__link"
                    onClick={close}
                  >
                    {track.artist}
                  </Link>
                ) : (
                  (track.artist ?? " ")
                )}
              </p>
              {track.album != null && (
                <p className="nowplaying__album">
                  {verified && track.album_id != null ? (
                    <Link
                      to={`/albums/${track.album_id}`}
                      className="nowplaying__link"
                      onClick={close}
                    >
                      {track.album}
                    </Link>
                  ) : (
                    track.album
                  )}
                </p>
              )}
              {/* The origin rides under the album line, small and
                  secondary — the queue's birth certificate. A restored
                  session's origin is linked only once the server has
                  vouched for the session. */}
              {origin?.label != null && (
                <p className="nowplaying__origin">
                  Playing from{" "}
                  {verified && origin.href ? (
                    <Link
                      to={origin.href}
                      className="nowplaying__link"
                      onClick={close}
                    >
                      {origin.label}
                    </Link>
                  ) : (
                    <span className="nowplaying__originname">{origin.label}</span>
                  )}
                </p>
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
              {/* The transport's quiet footnote, now a pair: the favorite
                  toggle and the filing pill share one row — a state and an
                  action at the same tier, the heart's circle drawn at the
                  pill's height so they read as siblings. The heart carries
                  the app's favorite grammar (outline → fill, the rows'
                  state language); the pill keeps its door into the shared
                  Add to Playlist dialog. Both hidden while the track is
                  unverified (a restored session): no door opens onto an id
                  the server hasn't vouched for — the same reason the names
                  above render as text. */}
              {verified && (
                <div className="nowplaying__actions">
                  <FavoriteButton track={track} className="nowplaying__fav" size={15} />
                  <button
                    type="button"
                    className="nowplaying__addto"
                    onClick={() => openAddToPlaylist([track])}
                    aria-haspopup="dialog"
                  >
                    <IconPlaylistAdd size={13} />
                    Add to Playlist
                  </button>
                </div>
              )}
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
