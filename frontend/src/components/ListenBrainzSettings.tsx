/* Settings → Scrobbling: ListenBrainz. The one thing in Flow that talks to
   the outside, so it is off until the owner pastes a token, and the row
   says exactly what leaves the server. The token is sent once to be saved
   and never shown again: the server only says whether one is set. */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";

interface Status {
  enabled: boolean;
  refused: boolean;
  sent: number;
  waiting: number;
}

export function ListenBrainzSettings({ status }: { status: Status | undefined }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const save = async (value: string | null) => {
    setPending(true);
    setError(null);
    try {
      const { response } = await api.PUT("/api/listenbrainz", { body: { token: value } });
      if (!response.ok) {
        setError(
          response.status === 400
            ? "ListenBrainz didn’t accept this token. Check it and try again."
            : "Couldn’t reach ListenBrainz. Try again later.",
        );
        return;
      }
      setEditing(false);
      setToken("");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch {
      setError("Couldn’t save that. Try again.");
    } finally {
      setPending(false);
    }
  };

  const hint = !status?.enabled
    ? "Off. With a ListenBrainz token, each song you play for 30 seconds (or half of a shorter one) is sent to your ListenBrainz profile: its title, artist, album, length and when you played it. Nothing else, and nothing at all until a token is saved."
    : status.refused
      ? "ListenBrainz refused the saved token, so nothing is being sent. Paste a new one."
      : `On. ${status.sent.toLocaleString()} sent${status.waiting > 0 ? `, ${status.waiting.toLocaleString()} waiting to be sent` : ""}. Title, artist, album, length and when you played it — nothing else.`;

  return (
    <div className="settings-group">
      <h2>Scrobbling</h2>
      <div className="settings-row settings-row--stack">
        <span className="settings-row__label">
          ListenBrainz
          <span className="settings-row__hint">{hint}</span>
        </span>
        <span className="settings-row__value">
          {status?.enabled ? (
            <>
              <button
                type="button"
                className="btn settings-row__action"
                onClick={() => setEditing((v) => !v)}
                aria-expanded={editing}
                disabled={pending}
              >
                Change Token
              </button>
              <button
                type="button"
                className="btn settings-row__action"
                onClick={() => void save(null)}
                disabled={pending}
              >
                Turn Off
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn settings-row__action"
              onClick={() => setEditing((v) => !v)}
              aria-expanded={editing}
              disabled={pending || status == null}
            >
              Turn On
            </button>
          )}
        </span>
      </div>
      {editing && (
        <div
          className="settings-row settings-row--skipped access-editor"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pending) setEditing(false);
          }}
        >
          <label className="access-field">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && token.trim()) void save(token.trim());
              }}
              placeholder="ListenBrainz user token"
              aria-label="ListenBrainz user token"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={200}
              autoFocus
              disabled={pending}
            />
          </label>
          {error && (
            <p className="access-editor__error" role="alert">
              {error}
            </p>
          )}
          <p className="access-editor__note">
            Your token is on your ListenBrainz settings page. Flow checks it with
            ListenBrainz once, keeps it on this server, and never shows it again.
          </p>
          <div className="access-editor__actions">
            <button type="button" className="btn" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn--primary"
              onClick={() => void save(token.trim())}
              disabled={pending || token.trim().length === 0}
            >
              {pending ? "Checking…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
