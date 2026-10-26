import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { fmtCount, fmtDateTime, scanStatusLabel } from "../lib/format";
import { HOME_ICON_FILES } from "../lib/homeIcon";
import { isIOS } from "../lib/platform";
import { openShortcutSheet } from "../lib/shortcuts";
import { usePlayerStore } from "../stores/player";
import { useScanStore } from "../stores/scan";
import { useUiStore, type HomeIcon, type ThemeMode } from "../stores/ui";
import { AccessSettings } from "../components/AccessSettings";
import { useReviewCount } from "../components/ReviewStrip";
import { ScanErrorsPanel } from "../components/ScanErrors";

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** A small picture beside the label (the Home Screen icon's tiles). */
  image?: string;
}

const THEME_MODES: SegmentedOption<ThemeMode>[] = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const HOME_ICONS: SegmentedOption<HomeIcon>[] = [
  { value: "light", label: "Light", image: HOME_ICON_FILES.light.touch },
  { value: "dark", label: "Dark", image: HOME_ICON_FILES.dark.touch },
];

/** A segmented radiogroup: ONE Tab stop (roving tabindex) — the checked
    option holds it, and the arrows choose — the native radio grammar. */
function SegmentedRadio<T extends string>({
  label,
  describedBy,
  options,
  value,
  onChange,
}: {
  label: string;
  describedBy?: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -1
              : 0;
        if (step === 0) return;
        e.preventDefault();
        const at = options.findIndex((o) => o.value === value);
        const next = (at + step + options.length) % options.length;
        onChange(options[next].value);
        e.currentTarget
          .querySelectorAll<HTMLElement>("[role=radio]")
          [next]?.focus();
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={`segmented__item${value === o.value ? " segmented__item--active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.image && <img className="segmented__img" src={o.image} alt="" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function countLabel(n: number, one: string, many: string): string {
  return `${fmtCount(n)} ${n === 1 ? one : many}`;
}

export function SettingsView() {
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const homeIcon = useUiStore((s) => s.homeIcon);
  const setHomeIcon = useUiStore((s) => s.setHomeIcon);
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

  // Re-reads every file, not just new or changed ones: retries files that
  // failed before and rebuilds repaired copies with the current pipeline.
  const fullRescan = async () => {
    await api.POST("/api/scan", { params: { query: { full: true } }, parseAs: "text" });
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
                <SegmentedRadio
                  label="Theme"
                  options={THEME_MODES}
                  value={themeMode}
                  onChange={setThemeMode}
                />
              </span>
            </div>
            {/* The tile a phone gets from "Add to Home Screen" / "Install
                app" — per device, like the theme. */}
            <div className="settings-row settings-row--stack">
              <span className="settings-row__label">
                Home Screen icon
                <span className="settings-row__hint" id="settings-homeicon-hint">
                  Used when you add Flow to a phone’s Home Screen. Already added?
                  Remove it and add it again to switch.
                </span>
              </span>
              <span className="settings-row__value">
                <SegmentedRadio
                  label="Home Screen icon"
                  describedBy="settings-homeicon-hint"
                  options={HOME_ICONS}
                  value={homeIcon}
                  onChange={setHomeIcon}
                />
              </span>
            </div>
            {/* The "?" sheet's pointer door — a shortcut list nobody can
                find is no help. */}
            <div className="settings-row">
              <span className="settings-row__label">Keyboard shortcuts</span>
              <span className="settings-row__value">
                Press <kbd className="settings-row__kbd">?</kbd> anywhere
                <button
                  type="button"
                  className="btn settings-row__action"
                  onClick={openShortcutSheet}
                  aria-haspopup="dialog"
                >
                  Show
                </button>
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
                  ? [
                      countLabel(counts.tracks, "song", "songs"),
                      countLabel(counts.albums, "album", "albums"),
                      countLabel(counts.artists, "artist", "artists"),
                      countLabel(counts.playlists, "playlist", "playlists"),
                    ].join(" · ")
                  : "Counting…"}
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-row__label">
                {/* Visual progress; the shell's Announcer speaks start/end. */}
                {scanning ? (
                  <span>{scan ? scanStatusLabel(scan) : "Scanning…"}</span>
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
            <div className="settings-row settings-row--stack">
              <span className="settings-row__label">
                Full rescan
                <span className="settings-row__hint" id="settings-fullscan-hint">
                  Re-reads every file instead of only new and changed ones,
                  retries files that couldn’t be read, and rebuilds repaired
                  copies. Slower on big libraries. Your edits, favorites, and
                  playlists are kept.
                </span>
              </span>
              <span className="settings-row__value">
                <button
                  type="button"
                  className="btn settings-row__action"
                  onClick={fullRescan}
                  disabled={scanning}
                  aria-describedby="settings-fullscan-hint"
                >
                  Rescan all
                </button>
              </span>
            </div>

            {/* Two doors, one room: the Tracks header serves the moment you
                spot the mess; this row serves the maintenance mindset. Both
                call openOrganize() and read the same review-summary cache —
                never add state or copy that isn't shared. */}
            <div className="settings-row settings-row--stack">
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
              <div className="settings-row settings-row--stack">
                <span className="settings-row__label">
                  <span id="settings-normalize-label">Normalize volume</span>
                  <span className="settings-row__hint" id="settings-normalize-hint">
                    Balances soft and loud songs, creating a more uniform
                    listening experience. Loudness is measured during the scan;
                    songs without a measurement play at their own level.
                  </span>
                </span>
                <span className="settings-row__value">
                  {/* Named by the row title, described by its hint; the
                      visible On/Off is decoration — aria-checked carries
                      the state (a switch named "On" said nothing). */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={soundcheck}
                    aria-labelledby="settings-normalize-label"
                    aria-describedby="settings-normalize-hint"
                    className={`settingstoggle${soundcheck ? " settingstoggle--on" : ""}`}
                    onClick={() => setSoundcheck(!soundcheck)}
                  >
                    <span className="settingstoggle__knob" aria-hidden="true" />
                    <span className="settingstoggle__label" aria-hidden="true">
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
