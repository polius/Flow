"""Optional password auth: PBKDF2 hashing + cookie sessions.

Auth exists only when an `auth_password` row is present in `settings`;
without it every request passes and nothing in this module runs. Sessions
live in the same key/value table (`auth_sessions` → JSON dict of
sha256(token) → expiry), so the first-version schema needs no migration —
sessions even survive container restarts. Only the token's digest is
stored: a copy of flow.db (a backup, a readable NAS share) holds nothing
that can be replayed as a cookie.

Sessions written by v1.5.0 are keyed by the plain token. They keep working:
every read maps a plain key to its digest, and the boot pass
(`upgrade_session_keys`) rewrites the row once so no plain token stays on
disk. A rollback to v1.5.0 then simply asks for a fresh sign-in.

The login gate runs on every request, so the password hash and the session
table are mirrored in memory (`request_allowed`). Every write in this module
drops the mirror; the process is the only writer (single worker), so a hand
edit of the settings row needs a restart to be seen.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from base64 import b64decode, b64encode

log = logging.getLogger("flow.auth")

AUTH_PASSWORD_KEY = "auth_password"
AUTH_SESSIONS_KEY = "auth_sessions"
SESSION_COOKIE = "flow_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days per sign-in
PBKDF2_ITERATIONS = 600_000  # OWASP guidance for PBKDF2-HMAC-SHA256
MIN_PASSWORD_LENGTH = 8


# ---- in-memory mirror for the gate ------------------------------------------

_cache_lock = threading.Lock()
_cache: dict[str, tuple[str | None, dict[str, float]]] = {}
_generation = 0


def _invalidate() -> None:
    global _generation
    with _cache_lock:
        _cache.clear()
        _generation += 1


def request_allowed(db, token: str | None) -> bool:
    """The gate's question, answered from memory after the first request:
    True when login is off, or when `token` names a live session."""
    key = str(db.path)
    with _cache_lock:
        entry = _cache.get(key)
        generation = _generation
    if entry is None:
        conn = db.connect()
        entry = (get_password_hash(conn), _read_sessions(conn))
        with _cache_lock:
            # A write that landed while we read must win over our copy.
            if generation == _generation:
                _cache[key] = entry
    stored, sessions = entry
    if stored is None:
        return True
    return _session_live(sessions, token)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        b64encode(salt).decode("ascii"),
        b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: str | None) -> bool:
    """Every success and every wrong-password guess costs one PBKDF2 run —
    the hash itself is the throttle when nginx's rate limit doesn't apply."""
    if not stored:
        return False
    try:
        scheme, iterations, salt_b64, digest_b64 = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        expected = b64decode(digest_b64)
        salt = b64decode(salt_b64)
    except (ValueError, TypeError):
        return False
    candidate = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, int(iterations)
    )
    return hmac.compare_digest(candidate, expected)


def get_password_hash(conn) -> str | None:
    row = conn.execute(
        "SELECT value FROM settings WHERE key = ?", (AUTH_PASSWORD_KEY,)
    ).fetchone()
    return row["value"] if row else None


def set_password_hash(conn, stored: str | None) -> None:
    """None disables login entirely."""
    if stored is None:
        conn.execute("DELETE FROM settings WHERE key = ?", (AUTH_PASSWORD_KEY,))
    else:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (AUTH_PASSWORD_KEY, stored),
        )
    conn.commit()
    _invalidate()


def apply_boot_env(conn, password: str | None, reset: bool) -> None:
    """FLOW_RESET_PASSWORD / FLOW_PASSWORD, applied once at startup.

    Reset clears the password and every session (the recovery path for a
    forgotten password). FLOW_PASSWORD then seeds a password only when none
    is set — it never overwrites one chosen in Settings.
    """
    if reset:
        log.warning(
            "FLOW_RESET_PASSWORD is set: login password and all sessions cleared. "
            "Remove the variable before the next restart."
        )
        set_password_hash(conn, None)
        clear_sessions(conn)
    if password and get_password_hash(conn) is None:
        if len(password) < MIN_PASSWORD_LENGTH:
            log.warning(
                "FLOW_PASSWORD is shorter than %d characters; consider a longer one",
                MIN_PASSWORD_LENGTH,
            )
        set_password_hash(conn, hash_password(password))
        log.info("Login enabled from FLOW_PASSWORD")


# ---- sessions ---------------------------------------------------------------


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _is_digest(key: str) -> bool:
    # token_urlsafe(32) is 43 characters, so a 64-hex key is always a digest.
    return len(key) == 64 and all(c in "0123456789abcdef" for c in key)


def _read_raw_sessions(conn) -> dict[str, float]:
    row = conn.execute(
        "SELECT value FROM settings WHERE key = ?", (AUTH_SESSIONS_KEY,)
    ).fetchone()
    if not row:
        return {}
    try:
        return {key: float(exp) for key, exp in json.loads(row["value"]).items()}
    except (ValueError, TypeError, AttributeError):
        return {}


def _read_sessions(conn) -> dict[str, float]:
    """digest → expiry. Plain-token keys (v1.5.0) are mapped to their digest."""
    return {
        (key if _is_digest(key) else _digest(key)): exp
        for key, exp in _read_raw_sessions(conn).items()
    }


def _session_live(sessions: dict[str, float], token: str | None) -> bool:
    if not token:
        return False
    expires = sessions.get(_digest(token))
    return expires is not None and expires > time.time()


def _write_sessions(conn, sessions: dict[str, float]) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (AUTH_SESSIONS_KEY, json.dumps(sessions)),
    )
    conn.commit()
    _invalidate()


def upgrade_session_keys(conn) -> None:
    """Boot pass: rewrite v1.5.0 plain-token keys as digests, in place, so
    signed-in browsers stay signed in and no replayable token stays on disk."""
    raw = _read_raw_sessions(conn)
    if any(not _is_digest(key) for key in raw):
        _write_sessions(conn, _read_sessions(conn))


def create_session(conn) -> str:
    now = time.time()
    sessions = {k: exp for k, exp in _read_sessions(conn).items() if exp > now}
    token = secrets.token_urlsafe(32)
    sessions[_digest(token)] = now + SESSION_TTL_SECONDS
    _write_sessions(conn, sessions)
    return token


def validate_session(conn, token: str | None) -> bool:
    return _session_live(_read_sessions(conn), token)


def revoke_session(conn, token: str | None) -> None:
    if not token:
        return
    sessions = _read_sessions(conn)
    if sessions.pop(_digest(token), None) is not None:
        _write_sessions(conn, sessions)


def clear_sessions(conn) -> None:
    conn.execute("DELETE FROM settings WHERE key = ?", (AUTH_SESSIONS_KEY,))
    conn.commit()
    _invalidate()


def revoke_other_sessions(conn, keep_token: str | None) -> None:
    """Password change: every other device must sign in again."""
    sessions = _read_sessions(conn)
    keep = _digest(keep_token) if keep_token else None
    kept = {keep: sessions[keep]} if keep in sessions else {}
    if kept != sessions:
        _write_sessions(conn, kept)
