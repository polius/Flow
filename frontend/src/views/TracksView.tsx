import { IconTracks } from "../components/icons";
import { EmptyState } from "../components/EmptyState";

export function TracksView() {
  return (
    <section className="view">
      <h1 className="view__title">Tracks</h1>
      <EmptyState
        icon={<IconTracks size={26} />}
        title="No tracks yet"
        hint="Every song in your library will live here, in a table built to stay smooth at ten thousand tracks."
      />
    </section>
  );
}
