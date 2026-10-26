/* Settings → Access: optional password login.

   Off by default — Flow opens freely until the owner sets a password.
   When on, this browser keeps its session; every other device signs in
   again after a password change. Changing the password or turning login
   off asks for the current one first: a borrowed session alone can't
   lock the owner out. The editor expands inline beneath its row — no
   modal, no ceremony. */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  AUTH_STATUS_KEY,
  logout,
  MIN_PASSWORD_LENGTH,
  setPassword as savePassword,
  useAuthStatus,
} from "../api/auth";
import { IconEye, IconEyeOff } from "./icons";

type EditorMode = "idle" | "enable" | "change" | "off";
type Pending = "save" | "signout" | "off" | null;

export function AccessSettings() {
  const { data: status } = useAuthStatus();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<EditorMode>("idle");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const needsCurrent = mode === "change" || mode === "off";
  const needsNew = mode === "enable" || mode === "change";
  const valid =
    (!needsCurrent || current.length > 0) &&
    (!needsNew || (password.length >= MIN_PASSWORD_LENGTH && password === confirm));
  const mismatch = confirm.length > 0 && password !== confirm;

  const reset = () => {
    setMode("idle");
    setCurrent("");
    setPassword("");
    setConfirm("");
    setReveal(false);
    setError(null);
    setCurrentError(null);
  };

  const open = (next: EditorMode) => {
    reset();
    setMode(next);
  };

  const onFail = (err: Error) => {
    if (err.message === "unauthenticated") {
      // The session died mid-edit — the shell guard will route to /login.
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        enabled: true,
        authenticated: false,
      });
      return;
    }
    if (err.message === "wrong-current-password") {
      // Said right where the mistake is; the field clears for a retry.
      setCurrentError("Current password is incorrect.");
      setCurrent("");
      return;
    }
    setError(
      err.message === "rate-limited"
        ? "Too many attempts. Wait a moment and try again."
        : "Couldn’t save that. Try again.",
    );
  };

  const save = async () => {
    setPending("save");
    setError(null);
    setCurrentError(null);
    try {
      await savePassword(password, mode === "change" ? current : undefined);
      // Saved — and this browser is signed in with the new password.
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        enabled: true,
        authenticated: true,
      });
      reset();
    } catch (err) {
      onFail(err as Error);
    } finally {
      setPending(null);
    }
  };

  const turnOff = async () => {
    setPending("off");
    setError(null);
    setCurrentError(null);
    try {
      await savePassword(null, current);
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        enabled: false,
        authenticated: false,
      });
      reset();
    } catch (err) {
      onFail(err as Error);
    } finally {
      setPending(null);
    }
  };

  const submit = () => {
    if (!valid || pending != null) return;
    void (mode === "off" ? turnOff() : save());
  };

  const signOut = async () => {
    setPending("signout");
    try {
      await logout();
      // The shell guard takes it from here: /login on the next render.
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        enabled: true,
        authenticated: false,
      });
    } finally {
      setPending(null);
    }
  };

  const editorOpen = mode !== "idle";

  const editor = editorOpen && (
    <div
      className="settings-row settings-row--skipped access-editor"
      onKeyDown={(e) => {
        if (e.key === "Escape" && pending == null) reset();
      }}
    >
      {needsCurrent && (
        <label className="access-field">
          <input
            type={reveal ? "text" : "password"}
            value={current}
            onChange={(e) => {
              setCurrentError(null);
              setCurrent(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && mode === "off") submit();
            }}
            placeholder="Current password"
            aria-label="Current password"
            aria-invalid={currentError != null}
            aria-describedby={currentError != null ? "access-current-error" : undefined}
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={128}
            autoFocus
            disabled={pending != null}
          />
          <button
            type="button"
            className="access-reveal"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? "Hide passwords" : "Show passwords"}
            aria-pressed={reveal}
            disabled={pending != null}
          >
            {reveal ? <IconEyeOff size={15} /> : <IconEye size={15} />}
          </button>
        </label>
      )}
      {currentError && (
        <p id="access-current-error" className="access-editor__error" role="alert">
          {currentError}
        </p>
      )}
      {needsNew && (
        <>
          <label className="access-field">
            <input
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              aria-label="New password"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={128}
              autoFocus={!needsCurrent}
              disabled={pending != null}
            />
            {!needsCurrent && (
              <button
                type="button"
                className="access-reveal"
                onClick={() => setReveal((v) => !v)}
                aria-label={reveal ? "Hide passwords" : "Show passwords"}
                aria-pressed={reveal}
                disabled={pending != null}
              >
                {reveal ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </button>
            )}
          </label>
          <label className="access-field">
            <input
              type={reveal ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Reenter password"
              aria-label="Reenter password"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={128}
              disabled={pending != null}
            />
          </label>
          {mismatch && (
            <p className="access-editor__error" role="alert">
              Passwords don’t match.
            </p>
          )}
        </>
      )}
      <p className="access-editor__note">
        {mode === "enable"
          ? `At least ${MIN_PASSWORD_LENGTH} characters. This becomes the password Flow asks for — keep it somewhere safe.`
          : mode === "change"
            ? `At least ${MIN_PASSWORD_LENGTH} characters. This device stays signed in; every other device signs in again.`
            : "Enter the current password to turn Login off. Flow will then open without asking for one."}
      </p>
      <div className="access-editor__actions">
        <button
          type="button"
          className="btn"
          onClick={reset}
          disabled={pending != null}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn--primary"
          onClick={submit}
          disabled={!valid || pending != null}
        >
          {mode === "enable" ? "Turn On" : mode === "off" ? "Turn Off" : "Save"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="settings-group">
      <h2>Access</h2>
      <div className="settings-row">
        <span className="settings-row__label">
          Login
          <span className="settings-row__hint">
            {status?.enabled
              ? "Flow asks for a password before it opens."
              : "Ask for a password when Flow opens. Off by default."}
          </span>
        </span>
        <span className="settings-row__value">
          {status == null ? (
            "…"
          ) : status.enabled ? (
            <>
              <span>On</span>
              <button
                type="button"
                className="btn settings-row__action"
                onClick={() => (mode === "change" ? reset() : open("change"))}
                aria-expanded={mode === "change"}
                disabled={pending != null}
              >
                Change Password
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn settings-row__action"
              onClick={() => open("enable")}
              disabled={pending != null}
            >
              Turn On
            </button>
          )}
        </span>
      </div>

      {mode !== "off" && editor}

      {status?.enabled && (
        <>
          <div className="settings-row">
            <span className="settings-row__label">
              Sign Out
              <span className="settings-row__hint">
                End this browser’s session. You’ll need the password to
                return.
              </span>
            </span>
            <span className="settings-row__value">
              <button
                type="button"
                className="btn settings-row__action"
                onClick={() => void signOut()}
                disabled={pending != null}
              >
                Sign Out
              </button>
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row__label">
              Turn Off
              <span className="settings-row__hint">
                Flow will open without asking for a password.
              </span>
            </span>
            <span className="settings-row__value">
              <button
                type="button"
                className="btn settings-row__action"
                onClick={() => (mode === "off" ? reset() : open("off"))}
                aria-expanded={mode === "off"}
                disabled={pending != null}
              >
                Turn Off
              </button>
            </span>
          </div>
          {mode === "off" && editor}
        </>
      )}

      {error && (
        <p className="access-editor__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
