"""Optional login: the gate, the session cookie, and password management.

The login endpoint's failure sleep is patched out — brute force defense
is measured in minutes, tests in milliseconds.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3

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
    response = client.put(
        "/api/auth/password",
        json={"password": "next5000", "current_password": "hunter2000"},
    )
    assert response.json() == {"enabled": True, "authenticated": True}
    assert fresh.get("/api/settings").status_code == 401
    assert client.get("/api/settings").status_code == 200
    assert _login(fresh, "next5000").status_code == 200


def test_disable_reopens_the_api_and_clears_sessions(client):
    _enable(client)
    fresh = client.__class__(client.app)
    _login(fresh, "hunter2000")

    response = client.put(
        "/api/auth/password",
        json={"password": None, "current_password": "hunter2000"},
    )
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


# ---- current password, minimum length, env bootstrap, hashed sessions -------


@pytest.fixture
def db_path(client):
    from app import config

    return config.DB_PATH


def test_change_and_disable_need_the_current_password(client):
    _enable(client)

    # A session alone is not enough: missing or wrong current password.
    for body in (
        {"password": "takeover1"},
        {"password": "takeover1", "current_password": "wrong-one"},
        {"password": None},
        {"password": None, "current_password": "wrong-one"},
    ):
        response = client.put("/api/auth/password", json=body)
        assert response.status_code == 403
        assert response.json() == {"detail": "Current password is incorrect."}

    # Nothing changed: the old password still signs in, login still on.
    fresh = client.__class__(client.app)
    assert _login(fresh, "hunter2000").status_code == 200
    assert client.get("/api/auth/status").json()["enabled"] is True


def test_new_passwords_need_eight_characters_old_ones_still_sign_in(client, db_path):
    from app import auth
    from app.db import Database

    assert client.put("/api/auth/password", json={"password": "seven77"}).status_code == 422

    # A 4-character password set before the rule must keep working.
    database = Database(db_path)
    auth.set_password_hash(database.connect(), auth.hash_password("abcd"))
    database.close_all()
    fresh = client.__class__(client.app)
    assert _login(fresh, "abcd").status_code == 200


def test_sessions_are_stored_hashed(client, db_path):
    token = _enable(client).cookies["flow_session"]
    conn = sqlite3.connect(db_path)
    stored = json.loads(
        conn.execute("SELECT value FROM settings WHERE key = 'auth_sessions'").fetchone()[0]
    )
    conn.close()
    assert token not in stored
    assert hashlib.sha256(token.encode()).hexdigest() in stored


def _boot(tmp_path, monkeypatch, library, **overrides):
    """A fresh app on a persistent data dir, with config overrides."""
    from fastapi.testclient import TestClient

    from app import config
    from app.main import create_app

    monkeypatch.setattr(config, "DB_PATH", tmp_path / "boot.db")
    monkeypatch.setattr(config, "MUSIC_DIR", library)
    monkeypatch.setattr(config, "DIST_DIR", None)
    monkeypatch.setattr(config, "PASSWORD", None)
    monkeypatch.setattr(config, "RESET_PASSWORD", False)
    for key, value in overrides.items():
        monkeypatch.setattr(config, key, value)
    app = create_app()
    monkeypatch.setattr(app.state.scanner, "start_scan", lambda trigger, full=False: False)
    return app, TestClient(app)


def test_v150_plain_sessions_survive_the_upgrade(tmp_path, monkeypatch, library):
    """A browser signed in under v1.5.0 (plain token as the settings key)
    stays signed in, and the row is rewritten without the plain token."""
    from app import auth

    app, c = _boot(tmp_path, monkeypatch, library)
    with c:
        pass
    app.state.db.close_all()
    conn = sqlite3.connect(tmp_path / "boot.db")
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('auth_password', ?)",
        (auth.hash_password("hunter2000"),),
    )
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('auth_sessions', ?)",
        (json.dumps({"legacy-token-from-v150": 4102444800.0}),),
    )
    conn.commit()
    conn.close()

    app, c = _boot(tmp_path, monkeypatch, library)
    with c:
        assert c.get("/api/settings").status_code == 401
        c.cookies.set("flow_session", "legacy-token-from-v150")
        assert c.get("/api/settings").status_code == 200
        assert c.get("/api/auth/status").json() == {"enabled": True, "authenticated": True}
        conn = sqlite3.connect(tmp_path / "boot.db")
        raw = conn.execute(
            "SELECT value FROM settings WHERE key = 'auth_sessions'"
        ).fetchone()[0]
        conn.close()
        assert "legacy-token-from-v150" not in raw
    app.state.db.close_all()


def test_flow_password_env_seeds_but_never_overwrites(tmp_path, monkeypatch, library):
    app, c = _boot(tmp_path, monkeypatch, library, PASSWORD="from-the-env")
    with c:
        assert c.get("/api/auth/status").json()["enabled"] is True
        assert c.get("/api/settings").status_code == 401
        assert _login(c, "from-the-env").status_code == 200
        # The owner picks their own password in Settings…
        assert c.put(
            "/api/auth/password",
            json={"password": "owner-choice", "current_password": "from-the-env"},
        ).status_code == 200
    app.state.db.close_all()

    # …and the next boot with the env still set doesn't revert it.
    app, c = _boot(tmp_path, monkeypatch, library, PASSWORD="from-the-env")
    with c:
        assert _login(c, "from-the-env").status_code == 401
        assert _login(c, "owner-choice").status_code == 200
    app.state.db.close_all()


def test_flow_reset_password_clears_login_and_sessions(tmp_path, monkeypatch, library):
    app, c = _boot(tmp_path, monkeypatch, library, PASSWORD="forgotten-one")
    with c:
        assert _login(c, "forgotten-one").status_code == 200
    app.state.db.close_all()

    app, c = _boot(tmp_path, monkeypatch, library, RESET_PASSWORD=True)
    with c:
        assert c.get("/api/auth/status").json() == {"enabled": False, "authenticated": False}
        assert c.get("/api/settings").status_code == 200
    app.state.db.close_all()

    # Reset + FLOW_PASSWORD together: the env value becomes the password.
    app, c = _boot(
        tmp_path, monkeypatch, library, RESET_PASSWORD=True, PASSWORD="brand-new-1"
    )
    with c:
        assert _login(c, "brand-new-1").status_code == 200
    app.state.db.close_all()


def test_gate_answers_from_memory_after_first_request(client, monkeypatch):
    """The async middleware must not query SQLite on every request."""
    from app import auth

    _enable(client)
    assert client.get("/api/settings").status_code == 200

    calls = []
    real = auth.get_password_hash
    monkeypatch.setattr(
        auth, "get_password_hash", lambda conn: calls.append(1) or real(conn)
    )
    for _ in range(5):
        assert client.get("/api/review/summary").status_code == 200
    assert calls == []

    # A logout is seen at once: every write drops the in-memory mirror.
    client.post("/api/auth/logout")
    assert client.get("/api/settings").status_code == 401
