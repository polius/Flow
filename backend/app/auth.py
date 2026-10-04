"""Optional password auth: PBKDF2 hashing + cookie sessions.

Auth exists only when an `auth_password` row is present in `settings`;
without it every request passes and nothing in this module runs. Sessions
live in the same key/value table (`auth_sessions` → JSON dict of token →
expiry), so the first-version schema needs no migration — sessions even
survive container restarts.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from base64 import b64decode, b64encode

AUTH_PASSWORD_KEY = "auth_password"
AUTH_SESSIONS_KEY = "auth_sessions"
SESSION_COOKIE = "flow_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days per sign-in
PBKDF2_ITERATIONS = 600_000  # OWASP guidance for PBKDF2-HMAC-SHA256


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


# ---- sessions ---------------------------------------------------------------


def _read_sessions(conn) -> dict[str, float]:
    row = conn.execute(
        "SELECT value FROM settings WHERE key = ?", (AUTH_SESSIONS_KEY,)
    ).fetchone()
    if not row:
        return {}
    try:
        return {token: float(exp) for token, exp in json.loads(row["value"]).items()}
    except (ValueError, TypeError):
        return {}


def _write_sessions(conn, sessions: dict[str, float]) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (AUTH_SESSIONS_KEY, json.dumps(sessions)),
    )
    conn.commit()


def create_session(conn) -> str:
    now = time.time()
    sessions = {t: exp for t, exp in _read_sessions(conn).items() if exp > now}
    token = secrets.token_urlsafe(32)
    sessions[token] = now + SESSION_TTL_SECONDS
    _write_sessions(conn, sessions)
    return token


def validate_session(conn, token: str | None) -> bool:
    if not token:
        return False
    expires = _read_sessions(conn).get(token)
    return expires is not None and expires > time.time()


def revoke_session(conn, token: str | None) -> None:
    if not token:
        return
    sessions = _read_sessions(conn)
    if token in sessions:
        del sessions[token]
        _write_sessions(conn, sessions)


def clear_sessions(conn) -> None:
    conn.execute("DELETE FROM settings WHERE key = ?", (AUTH_SESSIONS_KEY,))
    conn.commit()


def revoke_other_sessions(conn, keep_token: str | None) -> None:
    """Password change: every other device must sign in again."""
    sessions = _read_sessions(conn)
    kept = (
        {keep_token: sessions[keep_token]}
        if keep_token and keep_token in sessions
        else {}
    )
    if kept != sessions:
        _write_sessions(conn, kept)
