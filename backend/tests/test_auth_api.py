"""Optional login: the gate, the session cookie, and password management.

The login endpoint's failure sleep is patched out — brute force defense
is measured in minutes, tests in milliseconds.
"""

from __future__ import annotations

import pytest

from tests.audio_fixtures import make_mp3


@pytest.fixture(autouse=True)
def no_failure_sleep(monkeypatch):
    from app.routers import auth as auth_router

    monkeypatch.setattr(auth_router.time, "sleep", lambda _s: None)


@pytest.fixture
def library(music):
    make_mp3(music / "song.mp3", title="Song", artist="Artist", album="Album")
    return music


def _enable(client, password="hunter2000"):
    response = client.put("/api/auth/password", json={"password": password})
    assert response.status_code == 200
    assert response.json() == {"enabled": True, "authenticated": True}
    return response


def _login(client, password):
    return client.post("/api/auth/login", json={"password": password})


def test_api_open_when_login_never_enabled(client):
    assert client.get("/api/auth/status").json() == {
        "enabled": False,
        "authenticated": False,
    }
    # No password set: every library endpoint answers without a cookie.
    assert client.get("/api/settings").status_code == 200


def test_enabling_locks_the_api_and_issues_a_session(client):
    response = _enable(client)
    assert "flow_session" in response.cookies

    # The enabling browser keeps working…
    assert client.get("/api/settings").status_code == 200
    # …but a cookieless client is out.
    fresh = client.__class__(client.app)
    assert fresh.get("/api/settings").status_code == 401
    assert fresh.get("/api/auth/status").json() == {
        "enabled": True,
        "authenticated": False,
    }


def test_login_flow_right_and_wrong_password(client):
    _enable(client)
    fresh = client.__class__(client.app)

    wrong = fresh.post("/api/auth/login", json={"password": "nope"})
    assert wrong.status_code == 401
    assert fresh.get("/api/settings").status_code == 401

    assert _login(fresh, "hunter2000").status_code == 200
    assert fresh.get("/api/settings").status_code == 200


def test_password_change_revokes_other_sessions_only(client):
    _enable(client)
    fresh = client.__class__(client.app)
    _login(fresh, "hunter2000")

    # The signed-in browser changes the password; the other browser's
    # session must die, this one must survive.
    response = client.put("/api/auth/password", json={"password": "next5000"})
    assert response.json() == {"enabled": True, "authenticated": True}
    assert fresh.get("/api/settings").status_code == 401
    assert client.get("/api/settings").status_code == 200
    assert _login(fresh, "next5000").status_code == 200


def test_disable_reopens_the_api_and_clears_sessions(client):
    _enable(client)
    fresh = client.__class__(client.app)
    _login(fresh, "hunter2000")

    response = client.put("/api/auth/password", json={"password": None})
    assert response.json() == {"enabled": False, "authenticated": False}
    assert fresh.get("/api/settings").status_code == 200
    assert client.get("/api/auth/status").json() == {
        "enabled": False,
        "authenticated": False,
    }
    # Login itself is gone once disabled.
    assert _login(fresh, "hunter2000").status_code == 400


def test_logout_revokes_this_browser_only(client):
    _enable(client)
    fresh = client.__class__(client.app)
    _login(fresh, "hunter2000")

    assert fresh.post("/api/auth/logout").status_code == 200
    assert fresh.get("/api/settings").status_code == 401
    assert client.get("/api/settings").status_code == 200


def test_password_too_short_is_rejected(client):
    assert (
        client.put("/api/auth/password", json={"password": "abc"}).status_code
        == 422
    )
    assert client.get("/api/auth/status").json()["enabled"] is False


def test_login_endpoint_stays_reachable_when_locked_out(client):
    """The gate can't guard the door that opens it."""
    _enable(client)
    fresh = client.__class__(client.app)
    assert fresh.post("/api/auth/login", json={"password": "x"}).status_code == 401
    assert fresh.get("/api/auth/status").status_code == 200


def test_health_stays_public_for_the_container_healthcheck(client):
    _enable(client)
    fresh = client.__class__(client.app)
    assert fresh.get("/api/health").status_code == 200
