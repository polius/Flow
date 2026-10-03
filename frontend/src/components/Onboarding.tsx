/* First-run onboarding: an empty library is the FIRST thing a new owner
   sees — a blank grid reads as broken. This is the designed version: what
   Flow is, where the music folder lives, and the three steps to a playing
   library. Typography-carried, no wall of cards.

   Two variants, told apart by the server's `library_exists`:
   - folder present but empty → the normal "add music" walk-through;
   - folder missing → the calm broken-mount walk-through.

   FirstScan covers the third first-run moment: the startup auto-scan
   caught mid-flight — progress instead of emptiness. */

import type { ReactNode } from "react";
import { Link } from "react-router";

import { api } from "../api/client";
import type { SettingsOut } from "../api/types";
import { IconMusicNote } from "./icons";
import { scanStatusLabel } from "../lib/format";
import type { ScanStatus } from "../stores/scan";

/* One copy-scan-play step. The hairline between steps (not cards) keeps
   the page disciplined; the numeral is the only ornament. */
function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="onboard__step">
      <span className="onboard__num" aria-hidden="true">
        {n}
      </span>
      <div className="onboard__steptext">
        <span className="onboard__steptitle">{title}</span>
        <p className="onboard__stepbody">{children}</p>
      </div>
    </li>
  );
}

/* The configured music folder, as the server sees it. The single most
   useful fact on this page: it answers "where do I put my files?" —
   shown as a monospace chip because a path is data, not prose. */
function PathChip({ path }: { path: string }) {
  return (
    <code className="onboard__path" title={path}>
      {path}
    </code>
  );
}

export function FirstRun({ settings }: { settings: SettingsOut }) {
  const folderMissing = !settings.library_exists;
  const rescan = async () => {
    // 409 (scan already running) is expected and harmless; SSE carries it.
    await api.POST("/api/scan", { parseAs: "text" });
  };

  return (
    <div className="onboard">
      <div className="onboard__glyph" aria-hidden="true">
        <IconMusicNote size={26} />
      </div>
      <h2 className="onboard__title">
        {folderMissing ? "Flow can’t see your music folder" : "Welcome to Flow"}
      </h2>
      <p className="onboard__lede">
        {folderMissing
          ? "The folder Flow was pointed at isn’t there right now — usually a drive that isn’t mounted yet. Your library is safe: nothing has been removed."
          : "Point Flow at a folder of music files and it scans, indexes, and streams them — your files are never moved, renamed, or touched."}
      </p>

      <ol className="onboard__steps">
        {folderMissing ? (
          <>
            <Step n={1} title="Check the mount">
              Make sure the drive or share holding your music is mounted and
              this path exists: <PathChip path={settings.library_path} />
            </Step>
            <Step n={2} title="Check the mount">
              Make sure the volume in docker-compose.yml points at the folder
              holding your music (host <code className="onboard__code">./flow/music</code> →{" "}
              container <code className="onboard__code">/flow/music</code>) and
              restart the container.
            </Step>
            <Step n={3} title="Rescan">
              One scan brings every album, playlist, and edit back exactly as
              you left them.
            </Step>
          </>
        ) : (
          <>
            <Step n={1} title="Add your music">
              Copy your audio files — MP3, FLAC, M4A, or OGG — into the folder
              Flow is watching: <PathChip path={settings.library_path} />
            </Step>
            <Step n={2} title="Let Flow read it">
              New files are picked up on their own — a manual scan works too,
              any time.
            </Step>
            <Step n={3} title="Press play">
              Albums, artists, and playlists build themselves from your files’
              tags.
            </Step>
          </>
        )}
      </ol>

      <div className="onboard__actions">
        <button type="button" className="btn--primary" onClick={rescan}>
          {folderMissing ? "Rescan now" : "Scan library now"}
        </button>
        <Link to="/settings" className="btn">
          Open Settings
        </Link>
      </div>
    </div>
  );
}

/* The first scan caught mid-flight: the startup auto-scan is already doing
   exactly what the steps describe, so the page says so instead of showing
   a blank canvas. Live line under aria-live. */
export function FirstScan({ scan }: { scan: ScanStatus | null }) {
  const progress = scan && scanStatusLabel(scan);
  return (
    <div className="onboard" role="status">
      <div className="onboard__glyph" aria-hidden="true">
        <span className="onboard__spin" />
      </div>
      <h2 className="onboard__title">Building your library</h2>
      <p className="onboard__lede" aria-live="polite">
        {progress ?? "Scanning…"} — this page fills in as tracks arrive.
      </p>
    </div>
  );
}
