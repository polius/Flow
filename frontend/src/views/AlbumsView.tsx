import { IconAlbums } from "../components/icons";
import { EmptyState } from "../components/EmptyState";

export function AlbumsView() {
  return (
    <section className="view">
      <h1 className="view__title">Albums</h1>
      <EmptyState
        icon={<IconAlbums size={26} />}
        title="No albums yet"
        hint="Albums appear here once the library has been scanned."
      />
    </section>
  );
}
