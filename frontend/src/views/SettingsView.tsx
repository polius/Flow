import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { fmtCount, fmtDateTime, scanStatusLabel } from "../lib/format";
import { isIOS } from "../lib/platform";
import { usePlayerStore } from "../stores/player";
import { useScanStore } from "../stores/scan";
import { useUiStore, type ThemeMode } from "../stores/ui";
import { AccessSettings } from "../components/AccessSettings";
import { useReviewCount } from "../components/ReviewStrip";
import { ScanErrorsPanel } from "../components/ScanErrors";

const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "Auto" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

export function SettingsView() {
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const soundcheck = usePlayerStore((s) => s.soundcheck);
  const setSoundcheck = usePlayerStore((s) => s.setSoundcheck);
  const openOrganize = useUiStore((s) => s.openOrganize);
  const reviewCount = useReviewCount();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data } = await api.GET("/api/settings");
      return data;
    },
    refetchInterval: scanning ? 2000 : false,
  });

  const rescan = async () => {
    // 409 (already running) is expected and harmless; SSE carries the state.
    await api.POST("/api/scan", { parseAs: "text" });
  };

  const lastScan = fmtDateTime(scan?.finishedAt ?? null);
  const counts = settings?.counts;
  const errorCount = scan?.errors ?? 0;

  return (
    <section className="view">
      <h1 className="view__title">Settings</h1>
      <p className="view__subtitle">Appearance, access, library, and playback.</p>

      {scan?.mountGuard && (
        <div className="settings-guard" role="status">
          <h2>Your music folder wasn’t reachable</h2>
          <p>
            The last scan found an empty library — usually a disconnected drive
            or an unmounted network share. To protect your music, Flow removed
            nothing and changed nothing. Everything is exactly as it was.
          </p>
          <p className="settings-guard__hint">
            Check that the folder is mounted, then rescan.
          </p>
          <button type="button" className="btn--primary" onClick={rescan} disabled={scanning}>
            Rescan now
          </button>
        </div>
      )}

      {/* One left-pinned column: with the Keyboard section removed, nothing
          was left for a second column — every group lives in the first. */}
      <div className="settings-grid">
        <div className="settings-col">
          <div className="settings-group">
            <h2>Appearance</h2>
            <div className="settings-row">
              <span className="settings-row__label">Theme</span>
              <span className="settings-row__value">
                <div className="segmented" role="radiogroup" aria-label="Theme">
                  {THEME_MODES.map(({ mode, label }) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={themeMode === mode}
                      className={`segmented__item${themeMode === mode ? " segmented__item--active" : ""}`}
                      onClick={() => setThemeMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </span>
            </div>
          </div>

          <AccessSettings />

          <div className="settings-group">
            <h2>Library</h2>
            <div className="settings-row">
              <span className="settings-row__label">Contents</span>
              <span className="settings-row__value">
                {counts
                  ? `${fmtCount(counts.tracks)} tracks · ${fmtCount(counts.albums)} albums · ${fmtCount(counts.artists)} artists · ${fmtCount(counts.playlists)} playlists`
                  : "…"}
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">
                {scanning ? (
                  <span aria-live="polite">
                    {scan ? scanStatusLabel(scan) : "Scanning…"}
                  </span>
                ) : (
                  "Last scan"
                )}
              </span>
              <span className="settings-row__value">
                {!scanning && (lastScan ?? "never")}
                <button
                  type="button"
                  className="btn settings-row__action"
                  onClick={rescan}
                  disabled={scanning}
                >
                  Rescan
                </button>
              </span>
            </div>

            {/* Two doors, one room: the Tracks header serves the moment you
                spot the mess; this row serves the maintenance mindset. Both
                call openOrganize() and read the same review-summary cache —
                never add state or copy that isn't shared. */}
            <div className="settings-row">
              <span className="settings-row__label">
                Organize
                <span className="settings-row__hint">
                  Group tracks into albums and artists, fix metadata in bulk —
                  edits stay in the database, your music folder is never
                  touched.
                </span>
              </span>
              <span className="settings-row__value">
                {reviewCount > 0
                  ? `${fmtCount(reviewCount)} ${reviewCount === 1 ? "item needs" : "items need"} review`
                  : "Nothing needs review"}
                <button
                  type="button"
                  className="btn settings-row__action"
                  onClick={openOrganize}
                  aria-label={
                    reviewCount > 0
                      ? `Organize — ${reviewCount} ${reviewCount === 1 ? "item needs" : "items need"} attention`
                      : "Organize"
                  }
                  title="Organize — group tracks into albums and artists"
                >
                  Open
                </button>
              </span>
            </div>
            {!scanning && errorCount > 0 && (
              <div className="settings-row settings-row--skipped">
                <span className="settings-row__label">
                  Skipped
                  <span className="settings-row__hint">
                    These files could not be read. Fix them and rescan — the
                    scan changes nothing in your music folder.
                  </span>
                </span>
                <span className="settings-row__value">
                  <ScanErrorsPanel />
                </span>
              </div>
            )}
          </div>

          {/* Playback — but not on iOS: Sound Check rides the Web Audio
              graph, and the graph is bypassed there (the OS suspends it in
              the background, which would kill background playback). A
              setting that can't apply must not present itself. */}
          {!isIOS && (
            <div className="settings-group">
              <h2>Playback</h2>
              <div className="settings-row">
                <span className="settings-row__label">
                  Normalize volume
                  <span className="settings-row__hint">
                    Balances soft and loud songs, creating a more uniform
                    listening experience. Loudness is measured during the scan;
                    tracks without a measurement play at their own level.
                  </span>
                </span>
                <span className="settings-row__value">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={soundcheck}
                    className={`settingstoggle${soundcheck ? " settingstoggle--on" : ""}`}
                    onClick={() => setSoundcheck(!soundcheck)}
                  >
                    <span className="settingstoggle__knob" aria-hidden="true" />
                    <span className="settingstoggle__label">
                      {soundcheck ? "On" : "Off"}
                    </span>
                  </button>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
