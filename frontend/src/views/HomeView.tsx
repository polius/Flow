import { IconMusicNote } from "../components/icons";
import { EmptyState } from "../components/EmptyState";

export function HomeView() {
  return (
    <section className="view">
      <h1 className="view__title">Home</h1>
      <p className="view__subtitle">Recently added and continue listening land here.</p>
      <EmptyState
        icon={<IconMusicNote size={26} />}
        title="Your library is empty"
        hint="Point Flow at your music folder and it will scan, index, and stream it — without ever touching your files."
      />
    </section>
  );
}
