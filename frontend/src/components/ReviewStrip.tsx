/* "Needs attention": the Organize view's opinion about where the library
   needs grouping work. Deterministic counts only; each item is a filter
   for the grid below. Text-first and quiet — a healthy library collapses
   to one calm line. */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import type { ReviewSummary } from "../api/types";

interface ReviewStripProps {
  summary: ReviewSummary | undefined;
  activeReview: string | null;
  onPick: (review: string | null) => void;
  onPickAlbum: (albumId: number) => void;
}

export function ReviewStrip({ summary, activeReview, onPick, onPickAlbum }: ReviewStripProps) {
  const [collisionsOpen, setCollisionsOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ left: number; top: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!collisionsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setCollisionsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCollisionsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [collisionsOpen]);

  if (!summary) return null;

  const items: { key: string; count: number; label: string }[] = [
    {
      key: "no_album",
      count: summary.no_album,
      label: summary.no_album === 1 ? "track has no album" : "tracks have no album",
    },
    {
      key: "single_track_albums",
      count: summary.single_track_albums,
      label: summary.single_track_albums === 1 ? "album holds a single track" : "albums hold a single track",
    },
    {
      key: "mixed_album_artist",
      count: summary.mixed_album_artist_albums,
      label: summary.mixed_album_artist_albums === 1 ? "album mixes album artists" : "albums mix album artists",
    },
    {
      key: "missing_track_no",
      count: summary.missing_track_no,
      label: summary.missing_track_no === 1 ? "track lacks a track number" : "tracks lack a track number",
    },
  ];
  const problems = items.filter((i) => i.count > 0);
  const clean = problems.length === 0 && summary.suffix_collisions === 0;

  if (clean) {
    return (
      <p className="orgstrip orgstrip--clean" role="status">
        Nothing needs attention — every track is grouped and numbered.
      </p>
    );
  }

  const pill = (key: string, text: string, active: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      className={`orgstrip__pill${active ? " orgstrip__pill--on" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="orgstrip__count">{text.split(" ")[0]}</span>
      {text.slice(text.indexOf(" ") + 1)}
    </button>
  );

  return (
    <section className="orgstrip" aria-label="Needs attention">
      <p className="orgstrip__label">Needs attention</p>
      <div className="orgstrip__pills">
        {problems.map((i) =>
          pill(i.key, `${i.count} ${i.label}`, activeReview === i.key, () =>
            onPick(activeReview === i.key ? null : i.key),
          ),
        )}
        {summary.suffix_collisions > 0 && (
          <button
            type="button"
            className={`orgstrip__pill${collisionsOpen ? " orgstrip__pill--on" : ""}`}
            aria-expanded={collisionsOpen}
            aria-haspopup="dialog"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              // Fixed anchor taken at open time: the strip scrolls away under
              // the grid, the popover must not follow it into clipping.
              setAnchorRect({
                left: Math.min(rect.left, window.innerWidth - 436),
                top: Math.min(rect.bottom + 8, window.innerHeight - 340),
              });
              setCollisionsOpen((v) => !v);
            }}
          >
            <span className="orgstrip__count">{summary.suffix_collisions}</span>
            {summary.suffix_collisions === 1 ? "near-duplicate album name" : "near-duplicate album names"}
          </button>
        )}
        {activeReview && (
          <button type="button" className="orgstrip__clear" onClick={() => onPick(null)}>
            Show all
          </button>
        )}
      </div>

      {collisionsOpen && anchorRect && (
        <div
          ref={popRef}
          className="orgpop"
          role="dialog"
          aria-label="Near-duplicate album names"
          style={{ left: anchorRect.left, top: anchorRect.top }}
        >
          <p className="orgpop__hint">
            These album titles differ only by a variant suffix. Filter to one, then
            select its tracks and set the corrected album name.
          </p>
          {summary.collision_groups.map((group) => (
            <div key={group.key} className="orgpop__group">
              {group.albums.map((album) => (
                <button
                  key={album.id}
                  type="button"
                  className="orgpop__album"
                  onClick={() => {
                    onPickAlbum(album.id);
                    setCollisionsOpen(false);
                  }}
                >
                  {album.title}
                  <span className="orgpop__count">{album.track_count}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Hook for the Organize view: the review summary is the strip's data and
    the undo affordance's source of truth (undo state lives server-side). */
export function useReviewSummary() {
  return useQuery({
    queryKey: ["review", "summary"],
    queryFn: async () => {
      const { data } = await api.GET("/api/review/summary");
      return data;
    },
  });
}
