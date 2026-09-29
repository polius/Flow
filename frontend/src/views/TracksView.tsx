import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api } from "../api/client";
import { TrackTable } from "../components/TrackTable";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { IconTracks } from "../components/icons";
import { fmtCount } from "../lib/format";

// Full-library windowing lands with hardening (§11.6); until then the table
// fetches the first page and says so honestly.
const PAGE_SIZE = 1000;

export function TracksView() {
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const { data } = useQuery({
    queryKey: ["tracks", "all", q],
    queryFn: async () => {
      const { data } = await api.GET("/api/tracks", {
        params: { query: { limit: PAGE_SIZE, ...(q ? { q } : {}) } },
      });
      return data;
    },
  });

  const tracks = data?.items ?? [];
  const hidden = (data?.total ?? 0) - tracks.length;

  return (
    <section className="view">
      <h1 className="view__title">Tracks</h1>
      {data === undefined ? (
        <LoadingState variant="rows" />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon={<IconTracks size={26} />}
          title={q ? `No tracks match “${q}”` : "No tracks yet"}
          hint={
            q
              ? "Try a different word, or search everything from the Search view."
              : "Every song in your library will live here, in a table built to stay smooth at ten thousand tracks."
          }
        />
      ) : (
        <>
          <TrackTable tracks={tracks} variant="all" />
          {hidden > 0 && (
            <p className="libnote">
              Showing the first {fmtCount(tracks.length)} of {fmtCount(data!.total)} tracks —
              the full list arrives with list virtualization.
            </p>
          )}
        </>
      )}
    </section>
  );
}
