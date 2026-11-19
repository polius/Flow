/* Lyrics from the song's own files (a .lrc or .txt beside it, or its
   lyrics tag), read by the server on request: never fetched from the
   internet. Synced lyrics follow the music — the line being sung is lit
   and kept in view — and a tap on a line seeks there. Plain lyrics are
   shown as they are. */

import { useEffect, useRef } from "react";

import { currentLine, type LyricsData } from "../lib/lyrics";
import { usePlayerStore } from "../stores/player";

export function LyricsPanel({ lyrics, className = "" }: { lyrics: LyricsData; className?: string }) {
  const seek = usePlayerStore((s) => s.seek);
  const at = usePlayerStore((s) => (lyrics.synced ? currentLine(lyrics.lines, s.position) : -1));
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (at < 0) return;
    const line = listRef.current?.children[at] as HTMLElement | undefined;
    line?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [at]);

  return (
    <section className={`lyrics ${className}`} aria-label="Lyrics">
      <ol ref={listRef} className={`lyrics__lines${lyrics.synced ? " lyrics__lines--synced" : ""}`}>
        {lyrics.lines.map((line, i) => (
          <li
            key={i}
            className={`lyrics__line${i === at ? " lyrics__line--current" : ""}`}
            aria-current={i === at ? "true" : undefined}
          >
            {lyrics.synced && line.time != null ? (
              <button type="button" className="lyrics__seek" onClick={() => seek(line.time!)}>
                {line.text || "♪"}
              </button>
            ) : (
              line.text || " "
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
