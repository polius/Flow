import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { fmtCount, fmtDateTime, scanProgressLabel } from "../lib/format";
import { useScanStore } from "../stores/scan";

export function SettingsView() {
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";

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

  return (
    <section className="view">
      <h1 className="view__title">Settings</h1>
      <p className="view__subtitle">
        Keyboard shortcuts are documented here from Milestone 5.
      </p>

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
                {scan ? scanProgressLabel(scan.current, scan.total) : "Scanning…"}
              </span>
            ) : (
              "Last scan"
            )}
          </span>
          <span className="settings-row__value">
            {!scanning && (lastScan ?? "never")}
            {!scanning && scan && scan.errors > 0 ? ` · ${fmtCount(scan.errors)} errors` : ""}
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
      </div>
    </section>
  );
}
