/* Settings → Access: optional password login.

   Off by default — Flow opens freely until the owner sets a password.
   When on, this browser keeps its session; every other device signs in
   again after a password change. The editor expands inline beneath its
   row — no modal, no ceremony. */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  AUTH_STATUS_KEY,
  logout,
  setPassword as savePassword,
  useAuthStatus,
} from "../api/auth";
import { IconEye, IconEyeOff } from "./icons";

type EditorMode = "idle" | "enable" | "change";
type Pending = "save" | "signout" | "off" | null;

export function AccessSettings() {
  const { data: status } = useAuthStatus();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<EditorMode>("idle");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const offTimer = useRef<number | null>(null);

  const valid = password.length >= 4 && password === confirm;
  const mismatch = confirm.length > 0 && password !== confirm;

  // Two-step Turn Off: arming is always undone by doing anything else.
  const disarm = () => setConfirmingOff(false);

  useEffect(
    () => () => {
      if (offTimer.current != null) window.clearTimeout(offTimer.current);
    },
    [],
  );

  const reset = () => {
    setMode("idle");
    setPassword("");
    setConfirm("");
    setReveal(false);
    setError(null);
    disarm();
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
    setError(
      err.message === "rate-limited"
        ? "Too many attempts. Wait a moment and try again."
        : "Couldn’t save that. Try again.",
    );
  };

  const save = async () => {
    setPending("save");
    setError(null);
    try {
      await savePassword(password);
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
    try {
      await savePassword(null);
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

  const armOrTurnOff = () => {
    if (confirmingOff) {
      void turnOff();
      return;
    }
    setConfirmingOff(true);
    if (offTimer.current != null) window.clearTimeout(offTimer.current);
    offTimer.current = window.setTimeout(() => setConfirmingOff(false), 4000);
  };

  const editorOpen = mode !== "idle";

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
                onClick={() => {
                  disarm();
                  setMode(editorOpen ? "idle" : "change");
                }}
                disabled={pending != null}
              >
                Change Password
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn settings-row__action"
              onClick={() => {
                disarm();
                setMode("enable");
              }}
              disabled={pending != null}
            >
              Turn On
            </button>
          )}
        </span>
      </div>

      {editorOpen && (
        <div
          className="settings-row settings-row--skipped access-editor"
          onKeyDown={(e) => {
            if (e.key === "Escape" && pending == null) reset();
          }}
        >
          <label className="access-field">
            <input
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => {
                disarm();
                setPassword(e.target.value);
              }}
              placeholder="New password"
              aria-label="New password"
              autoComplete="new-password"
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
          <label className="access-field">
            <input
              type={reveal ? "text" : "password"}
              value={confirm}
              onChange={(e) => {
                disarm();
                setConfirm(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && pending == null) void save();
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
          <p className="access-editor__note">
            {mode === "enable"
              ? "At least 4 characters. This becomes the password Flow asks for — keep it somewhere safe."
              : "This device stays signed in; every other device signs in again."}
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
              onClick={() => void save()}
              disabled={!valid || pending != null}
            >
              {mode === "enable" ? "Turn On" : "Save"}
            </button>
          </div>
        </div>
      )}

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
                onClick={armOrTurnOff}
                onBlur={() => setConfirmingOff(false)}
                disabled={pending != null}
              >
                {confirmingOff ? "Confirm" : "Turn Off"}
              </button>
            </span>
          </div>
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
