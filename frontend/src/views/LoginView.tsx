/* Full-screen sign-in — the one page without the app chrome.

   Shown only when the owner turned Login on in Settings. Everything about
   it says "calm and few": one card, one field, one button. The palette
   stays monochrome — a wrong password speaks through motion (the card
   shakes once) and words, never a red splash. */

import { useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { AUTH_STATUS_KEY, login, useAuthStatus } from "../api/auth";
import { IconEye, IconEyeOff, IconMusicNote } from "../components/icons";
import "../styles/login.css";

export function LoginView() {
  const { data: status } = useAuthStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [shake, setShake] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The guard hands over where the user was heading; land them there.
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const signIn = useMutation({
    mutationFn: () => login(password),
    onSuccess: () => {
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        enabled: true,
        authenticated: true,
      });
      // Queries that 401'd before the redirect may sit cached as errors.
      void queryClient.invalidateQueries();
      void navigate(from, { replace: true });
    },
    onError: (err: Error) => {
      setMessage(
        err.message === "rate-limited"
          ? "Too many attempts. Wait a moment and try again."
          : "Incorrect password. Try again.",
      );
      setShake(true);
      // Keep what was typed — just select it, so the next attempt can
      // type straight over it.
      inputRef.current?.select();
    },
  });

  const trackCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState("CapsLock"));
  };

  // Login is off — nobody can sign in. (Direct visits to /login only.)
  if (status && !status.enabled) return <Navigate to="/" replace />;
  // Already signed in on this browser.
  if (status?.authenticated) return <Navigate to={from} replace />;

  return (
    <div className="login">
      <div
        className={`login__float${shake ? " login__float--shake" : ""}`}
        onAnimationEnd={() => setShake(false)}
      >
        <form
          className="login__card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!signIn.isPending && password.length > 0) {
              setMessage(null);
              signIn.mutate();
            }
          }}
        >
          <div className="login__glyph" aria-hidden="true">
            <IconMusicNote size={26} />
          </div>
          <h1 className="login__title">Sign in to Flow</h1>
          <p className="login__lede">Enter the password you set in Settings.</p>

          <div className="login__field">
            <input
              ref={inputRef}
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setMessage(null);
              }}
              onKeyDown={trackCapsLock}
              onKeyUp={trackCapsLock}
              placeholder="Password"
              aria-label="Password"
              aria-invalid={message != null}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              disabled={signIn.isPending}
            />
            <button
              type="button"
              className="login__reveal"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? "Hide password" : "Show password"}
              aria-pressed={reveal}
              disabled={signIn.isPending}
            >
              {reveal ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
          </div>

          {capsLock && (
            <p className="login__hint" role="status">
              Caps Lock is on.
            </p>
          )}
          {message && (
            <p className="login__error" role="alert">
              {message}
            </p>
          )}

          <button
            type="submit"
            className="login__submit"
            disabled={signIn.isPending || password.length === 0}
          >
            {signIn.isPending ? (
              <span className="login__spin" aria-hidden="true" />
            ) : (
              "Sign In"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
