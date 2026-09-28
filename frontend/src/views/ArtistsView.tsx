import { IconArtists } from "../components/icons";
import { EmptyState } from "../components/EmptyState";

export function ArtistsView() {
  return (
    <section className="view">
      <h1 className="view__title">Artists</h1>
      <EmptyState
        icon={<IconArtists size={26} />}
        title="No artists yet"
        hint="Artists appear here once the library has been scanned."
      />
    </section>
  );
}
