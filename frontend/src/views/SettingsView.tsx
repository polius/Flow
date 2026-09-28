export function SettingsView() {
  return (
    <section className="view">
      <h1 className="view__title">Settings</h1>
      <p className="view__subtitle">
        Library settings arrive with the scanner; keyboard shortcuts are documented here from
        Milestone 5.
      </p>

      <div className="settings-group">
        <h2>Library</h2>
        <div className="settings-row">
          <span className="settings-row__label">Music folder</span>
          <span className="settings-row__value">set via FLOW_MUSIC_DIR</span>
        </div>
      </div>
    </section>
  );
}
