/* Track table shared by Tracks, album detail, and artist detail (§9.2).
   Plain rows for Milestone 3; windowing arrives with hardening (§11.6). */

import { useState } from "react";
import { Link } from "react-router";

import type { Track } from "../api/types";
import { fmtDuration } from "../lib/format";
import { useCurrentTrack, usePlayerStore } from "../stores/player";
import "../styles/library.css";
import { IconPause, IconPlay } from "./icons";

type Variant = "album" | "all" | "artist";

interface TrackTableProps {
  tracks: Track[];
  variant?: Variant;
  /** Context played when a row is activated — defaults to `tracks`. */
  context?: Track[];
}

export function TrackTable({ tracks, variant = "all", context }: TrackTableProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTracks = usePlayerStore((s) => s.playTracks);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  const play = (index: number) => playTracks(context ?? tracks, index);

  const columns =
    variant === "album"
      ? "trackrow--album"
      : variant === "artist"
        ? "trackrow--artist"
        : "trackrow--all";

  return (
    <div className={`tracktable tracktable--${variant}`} role="table" aria-label="Tracks">
      {tracks.map((track, index) => {
        const isCurrent = current?.id === track.id;
        const classes = [
          "trackrow",
          columns,
          isCurrent ? "trackrow--playing" : "",
          selectedId === track.id && !isCurrent ? "trackrow--selected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div
            key={track.id}
            className={classes}
            role="row"
            onClick={() => setSelectedId(track.id)}
            onDoubleClick={() => (isCurrent ? togglePlay() : play(index))}
          >
            <span className="trackrow__index" aria-hidden="true">
              <span className="trackrow__num">
                {variant === "album" ? track.track_no ?? index + 1 : index + 1}
              </span>
              <button
                type="button"
                className="trackrow__play"
                aria-label={isCurrent && isPlaying ? "Pause" : `Play ${track.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  isCurrent ? togglePlay() : play(index);
                }}
              >
                {isCurrent && isPlaying ? <IconPause size={15} /> : <IconPlay size={15} />}
              </button>
            </span>
            <span className="trackrow__title" title={track.title}>
              {track.title}
            </span>
            {variant !== "album" && (
              <span className="trackrow__secondary">
                {track.artist_id != null ? (
                  <Link to={`/artists/${track.artist_id}`} onClick={(e) => e.stopPropagation()}>
                    {track.artist}
                  </Link>
                ) : (
                  track.artist
                )}
              </span>
            )}
            {variant !== "artist" && variant !== "album" && (
              <span className="trackrow__secondary trackrow__album">
                {track.album_id != null ? (
                  <Link to={`/albums/${track.album_id}`} onClick={(e) => e.stopPropagation()}>
                    {track.album}
                  </Link>
                ) : (
                  track.album
                )}
              </span>
            )}
            <span className="trackrow__time">{fmtDuration(track.duration)}</span>
          </div>
        );
      })}
    </div>
  );
}
