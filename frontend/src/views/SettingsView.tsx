import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { fmtCount, fmtDateTime, scanPhaseLabel, scanProgressLabel } from "../lib/format";
import { usePlayerStore } from "../stores/player";
import { useScanStore } from "../stores/scan";
import { useUiStore, type ThemeMode } from "../stores/ui";

const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "Auto" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

function ShortcutRow({ action, keys }: { action: string; keys: string[] }) {
  return (
    <div className="settings-row">
      <span className="settings-row__label">{action}</span>
      <span className="settings-row__value">
        {keys.map((k) => (
          <kbd key={k} className="settings-kbd">
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

/* The scan-error disclosure (§2.8): the scan's failure modes — files that
   couldn't be read, mounts that went away — were collected but never shown.
   Calm by design: a count, then path + reason on demand. */
function ScanErrors({ errorCount }: { errorCount: number }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["scan", "errors"],
    queryFn: async () => {
      const { data } = await api.GET("/api/scan/errors");
      return data;
    },
    enabled: open,
  });

  return (
    <div className="settings-errors">
      <button
        type="button"
        className="settings-errors__toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {fmtCount(errorCount)} {errorCount === 1 ? "file" : "files"} skipped
        <span className="settings-errors__chev" aria-hidden="true">
          {open ? "Hide" : "View"}
        </span>
      </button>
      {open && (
        <div className="settings-errors__list" role="list">
          {data === undefined ? (
            <span className="settings-errors__empty">Loading…</span>
          ) : data.items.length === 0 ? (
            <span className="settings-errors__empty">Nothing to show.</span>
          ) : (
            data.items.map((item) => (
              <div key={item.path} className="settings-errors__row" role="listitem">
                <span className="settings-errors__path" title={item.path}>
                  {item.path}
                </span>
                <span className="settings-errors__reason">{item.reason}</span>
              </div>
            ))
          )}
          {data?.truncated && (
            <span className="settings-errors__empty">
              Showing the first {fmtCount(data.items.length)} of {fmtCount(data.total)}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function SettingsView() {
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const soundcheck = usePlayerStore((s) => s.soundcheck);
  const setSoundcheck = usePlayerStore((s) => s.setSoundcheck);

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
      <p className="view__subtitle">Library status, appearance, and keyboard shortcuts.</p>

      {/* The mount guard (§2.8) gets its own calm state, not a bare count:
          what happened, what was (and wasn't) touched, what to do. */}
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

      <div className="settings-group">
        <h2>Library</h2>
        <div className="settings-row">
          <span className="settings-row__label">Music folder</span>
          <span className="settings-row__value">
            {settings ? settings.library_path : "…"}
            {settings && !settings.library_exists ? " (missing)" : ""}
          </span>
        </div>
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
                {scan
                  ? (scanPhaseLabel(scan.phase) ??
                    scanProgressLabel(scan.current, scan.total))
                  : "Scanning…"}
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
        {!scanning && errorCount > 0 && (
          <div className="settings-row">
            <span className="settings-row__label">Skipped</span>
            <span className="settings-row__value">
              <ScanErrors errorCount={errorCount} />
            </span>
          </div>
        )}
      </div>

      <div className="settings-group">
        <h2>Playback</h2>
        <div className="settings-row">
          <span className="settings-row__label">
            Sound Check
            <span className="settings-row__hint">
              Match volume across tracks — loudness is measured during the
              scan, tracks without a measurement play at their own level.
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

      <div className="settings-group">
        <h2>Keyboard</h2>
        <ShortcutRow action="Play / pause" keys={["Space"]} />
        <ShortcutRow action="Next / previous track" keys={["⌘→ / ⌘←", "Ctrl → / Ctrl ←"]} />
        <ShortcutRow action="Mute / unmute" keys={["M"]} />
        <ShortcutRow action="Seek backward / forward 10s" keys={["←", "→"]} />
        <ShortcutRow action="Volume down / up" keys={["↓", "↑"]} />
        <ShortcutRow action="Search" keys={["⌘F", "Ctrl F"]} />
        <ShortcutRow action="Close menu / panel / Now Playing" keys={["Esc"]} />
        {/* §2.4: the §31.7 table grammar, documented where the rest of the
            keyboard lives — the list and the implementation are one grammar;
            they had drifted apart, which is the §8.0.5 lesson applied to
            documentation. */}
        <p className="settings-subhead">In tables</p>
        <ShortcutRow action="Move the row cursor" keys={["↑", "↓"]} />
        <ShortcutRow action="Jump to start / end" keys={["Home", "End"]} />
        <ShortcutRow action="Page up / down" keys={["PageUp", "PageDown"]} />
        <ShortcutRow action="Play the cursor row" keys={["Enter"]} />
        <ShortcutRow action="Toggle playback" keys={["Space"]} />
      </div>
    </section>
  );
}
