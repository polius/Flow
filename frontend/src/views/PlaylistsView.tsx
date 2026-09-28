import { IconPlaylists } from "../components/icons";
import { EmptyState } from "../components/EmptyState";

export function PlaylistsView() {
  return (
    <section className="view">
      <h1 className="view__title">Playlists</h1>
      <EmptyState
        icon={<IconPlaylists size={26} />}
        title="No playlists yet"
        hint="Create a playlist once your library has been scanned."
      />
    </section>
  );
}
