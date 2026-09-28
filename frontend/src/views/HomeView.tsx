import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { fmtCount, scanProgressLabel } from "../lib/format";
import { useScanStore } from "../stores/scan";
import { IconMusicNote } from "../components/icons";
import { EmptyState } from "../components/EmptyState";

export function HomeView() {
  const scan = useScanStore((s) => s.status);
  const scanning = scan?.state === "scanning";

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data } = await api.GET("/api/settings");
      return data;
    },
  });

  const counts = settings?.counts;
  const hasLibrary = (counts?.tracks ?? 0) > 0;

  const summary = counts
    ? `${fmtCount(counts.tracks)} tracks · ${fmtCount(counts.albums)} albums · ${fmtCount(counts.artists)} artists`
    : null;

  return (
    <section className="view">
      <h1 className="view__title">Home</h1>
      {scanning ? (
        <p className="view__subtitle" aria-live="polite">
          {scan && scanProgressLabel(scan.current, scan.total)}
        </p>
      ) : hasLibrary ? (
        <p className="view__subtitle">{summary}</p>
      ) : null}

      {!scanning && !hasLibrary && (
        <EmptyState
          icon={<IconMusicNote size={26} />}
          title="Your library is empty"
          hint="Point Flow at your music folder and it will scan, index, and stream it — without ever touching your files."
        />
      )}
    </section>
  );
}
