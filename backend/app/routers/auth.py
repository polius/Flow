"""Optional login: status, sign in/out, and password management.

The actual gate is middleware in main.py — these endpoints are the only
API paths reachable without a session (besides /api/health), because they
are how a session gets earned in the first place.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request, Response

from app import auth
from app.schemas import AuthStatus, LoginIn, PasswordIn

router = APIRouter(tags=["auth"])


def _issue_cookie(request: Request, response: Response, conn) -> None:
    token = auth.create_session(conn)
    response.set_cookie(
        auth.SESSION_COOKIE,
        token,
        max_age=auth.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        # Behind an https terminator the cookie rides along fine unflagged;
        # flag it only when the request actually arrived https so plain-HTTP
        # LAN use never sets a cookie the browser would then refuse.
        secure=request.url.scheme == "https",
        path="/",
    )


@router.get("/api/auth/status", response_model=AuthStatus)
def auth_status(request: Request) -> AuthStatus:
    """Auth status.

    One question per page load: is login on, and does this browser
    already hold a valid session?
    """
    conn = request.app.state.db.connect()
    enabled = auth.get_password_hash(conn) is not None
    authenticated = enabled and auth.validate_session(
        conn, request.cookies.get(auth.SESSION_COOKIE)
    )
    return AuthStatus(enabled=enabled, authenticated=authenticated)


@router.post("/api/auth/login", response_model=AuthStatus)
def login(request: Request, response: Response, body: LoginIn) -> AuthStatus:
    """Login. Verify the password and set the session cookie."""
    conn = request.app.state.db.connect()
    stored = auth.get_password_hash(conn)
    if stored is None:
        raise HTTPException(status_code=400, detail="Login is not enabled.")
    if not auth.verify_password(body.password, stored):
        # A short pause keeps online guessing expensive even where nginx's
        # rate limit doesn't apply (bare uvicorn / dev).
        time.sleep(0.3)
        raise HTTPException(status_code=401, detail="Incorrect password.")
    _issue_cookie(request, response, conn)
    return AuthStatus(enabled=True, authenticated=True)


@router.post("/api/auth/logout", response_model=AuthStatus)
def logout(request: Request, response: Response) -> AuthStatus:
    """Logout. Revoke this browser's session and clear the cookie."""
    conn = request.app.state.db.connect()
    auth.revoke_session(conn, request.cookies.get(auth.SESSION_COOKIE))
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    enabled = auth.get_password_hash(conn) is not None
    return AuthStatus(enabled=enabled, authenticated=False)


@router.put("/api/auth/password", response_model=AuthStatus)
def set_password(
    request: Request, response: Response, body: PasswordIn
) -> AuthStatus:
    """Set Password. Turn login on, change the password, or turn it off
    (password: null).

    When login is already on, the middleware requires a session to reach
    here — Settings changes come from a signed-in browser. Turning login
    on issues this browser its session immediately, so the person who
    enabled it isn't locked out by their own next click.
    """
    conn = request.app.state.db.connect()
    current = auth.get_password_hash(conn)

    if body.password is None:
        auth.set_password_hash(conn, None)
        auth.clear_sessions(conn)
        response.delete_cookie(auth.SESSION_COOKIE, path="/")
        return AuthStatus(enabled=False, authenticated=False)

    auth.set_password_hash(conn, auth.hash_password(body.password))
    if current is None:
        # Enabling: this browser signs in as part of the save.
        _issue_cookie(request, response, conn)
        return AuthStatus(enabled=True, authenticated=True)

    # Changing: keep this browser's session, revoke every other device's.
    auth.revoke_other_sessions(conn, request.cookies.get(auth.SESSION_COOKIE))
    return AuthStatus(enabled=True, authenticated=True)
