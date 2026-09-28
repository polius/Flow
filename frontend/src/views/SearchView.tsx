import { IconSearch } from "../components/icons";
import { EmptyState } from "../components/EmptyState";

export function SearchView() {
  return (
    <section className="view">
      <h1 className="view__title">Search</h1>
      <EmptyState
        icon={<IconSearch size={26} />}
        title="Nothing to search yet"
        hint="Search spans tracks, albums, artists, and playlists once the library has been scanned."
      />
    </section>
  );
}
