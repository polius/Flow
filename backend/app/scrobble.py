"""Scrobbling to ListenBrainz (G3) — the one place Flow talks to the
outside, and only once the owner pastes a ListenBrainz token in Settings.

With no token: no listen is queued and no request leaves the server.
With one: each counted play (30 s, or half a shorter song) is queued in
the same transaction that records it, and a background thread sends the
queue — title, artist, album, length and when it was played, nothing
else. A send that fails stays queued and is retried later with a growing
delay; playback never waits on it. A token ListenBrainz refuses stops the
sending until a new one is saved. Standard library only.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

from app import __version__, config
from app.db import Database

log = logging.getLogger("flow.scrobble")

TOKEN_KEY = "listenbrainz_token"
REFUSED_KEY = "listenbrainz_refused"
SENT_KEY = "listenbrainz_sent"

BATCH = 50
IDLE_S = 60.0  # how often the sender looks at the queue on its own
TIMEOUT_S = 10.0
MAX_DELAY_S = 3600.0


class TokenRefused(Exception):
    """ListenBrainz answered 401: the token is wrong or revoked."""


def _get(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _put(conn, key: str, value: str | None) -> None:
    if value is None:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def token(conn) -> str | None:
    return _get(conn, TOKEN_KEY) or None


def status(conn) -> dict:
    """What Settings shows. Never the token itself."""
    waiting = conn.execute("SELECT COUNT(*) c FROM listenbrainz_queue").fetchone()["c"]
    return {
        "enabled": token(conn) is not None,
        "refused": _get(conn, REFUSED_KEY) == "1",
        "sent": int(_get(conn, SENT_KEY) or 0),
        "waiting": waiting,
    }


def _request(path: str, tok: str, body: dict | None = None) -> int:
    """One HTTPS request to ListenBrainz; the HTTP status. Raises OSError
    (urllib's URLError included) when there is no answer."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{config.LISTENBRAINZ_URL}{path}",
        data=data,
        method="POST" if body is not None else "GET",
        headers={
            "Authorization": f"Token {tok}",
            "Content-Type": "application/json",
            "User-Agent": f"Flow/{__version__}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:  # noqa: S310 - fixed https base
            return res.status
    except urllib.error.HTTPError as err:
        return err.code


def validate(tok: str) -> bool:
    """Ask ListenBrainz whether it knows this token (on save only). Raises
    OSError when it cannot be reached."""
    if _request("/1/validate-token", tok) == 401:
        return False
    return True


def set_token(conn, tok: str | None) -> None:
    """Save (or with None, clear) the token. Clearing also drops the queue:
    turned off means nothing more is sent."""
    _put(conn, TOKEN_KEY, tok)
    _put(conn, REFUSED_KEY, None)
    if tok is None:
        conn.execute("DELETE FROM listenbrainz_queue")


def enqueue(conn, play_id: int) -> None:
    """Queue a counted play — only while a working token is set. Runs in
    the caller's transaction."""
    if token(conn) is None or _get(conn, REFUSED_KEY) == "1":
        return
    conn.execute("INSERT OR IGNORE INTO listenbrainz_queue (play_id) VALUES (?)", (play_id,))


def _listens(conn, now: float) -> list:
    return conn.execute(
        """
        SELECT q.play_id, q.attempts, p.played_at, t.title, t.duration,
               ar.name AS artist, al.title AS album
        FROM listenbrainz_queue q
        JOIN plays p ON p.id = q.play_id
        JOIN tracks t ON t.id = p.track_id
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums al ON al.id = t.album_id
        WHERE q.next_try <= ?
        ORDER BY q.play_id
        LIMIT ?
        """,
        (now, BATCH),
    ).fetchall()


def _payload(rows: list) -> dict:
    listens = []
    for r in rows:
        meta: dict = {"artist_name": r["artist"], "track_name": r["title"]}
        if r["album"]:
            meta["release_name"] = r["album"]
        info: dict = {"submission_client": "Flow", "submission_client_version": __version__}
        if r["duration"]:
            info["duration_ms"] = int(r["duration"] * 1000)
        meta["additional_info"] = info
        listened_at = int(datetime.fromisoformat(r["played_at"]).timestamp())
        listens.append({"listened_at": listened_at, "track_metadata": meta})
    return {"listen_type": "single" if len(listens) == 1 else "import", "payload": listens}


def send_due(db: Database, now: float | None = None) -> int:
    """Send what is due; the number sent. Nothing at all without a token."""
    conn = db.connect()
    tok = token(conn)
    if tok is None or _get(conn, REFUSED_KEY) == "1":
        return 0
    now = time.time() if now is None else now
    rows = _listens(conn, now)
    # ListenBrainz needs an artist: a song without one cannot be sent.
    nameless = [r["play_id"] for r in rows if not r["artist"]]
    if nameless:
        conn.executemany("DELETE FROM listenbrainz_queue WHERE play_id = ?", [(i,) for i in nameless])
        conn.commit()
    rows = [r for r in rows if r["artist"]]
    if not rows:
        return 0
    try:
        code = _request("/1/submit-listens", tok, _payload(rows))
    except OSError as exc:
        code = None
        log.info("ListenBrainz unreachable (%s); %d listen(s) kept for later", exc, len(rows))
    if code == 401:
        _put(conn, REFUSED_KEY, "1")
        conn.commit()
        log.warning("ListenBrainz refused the token; nothing more is sent until a new one is saved")
        return 0
    if code is not None and 200 <= code < 300:
        conn.executemany("DELETE FROM listenbrainz_queue WHERE play_id = ?", [(r["play_id"],) for r in rows])
        _put(conn, SENT_KEY, str(int(_get(conn, SENT_KEY) or 0) + len(rows)))
        conn.commit()
        return len(rows)
    if code is not None:
        log.info("ListenBrainz answered %s; %d listen(s) kept for later", code, len(rows))
    for r in rows:
        delay = min(60.0 * 2 ** r["attempts"], MAX_DELAY_S)
        conn.execute(
            "UPDATE listenbrainz_queue SET attempts = attempts + 1, next_try = ? WHERE play_id = ?",
            (now + delay, r["play_id"]),
        )
    conn.commit()
    return 0


class Sender:
    """The background thread: wakes when a play is queued (kick) and every
    minute on its own. Never raises into the app."""

    def __init__(self, db: Database) -> None:
        self._db = db
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start (or, after a stop, restart: the app's lifespan may run
        more than once in one process) the sending thread."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._wake.clear()
        self._thread = threading.Thread(target=self._run, name="flow-scrobble", daemon=True)
        self._thread.start()

    def kick(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=TIMEOUT_S + 2)

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(IDLE_S)
            self._wake.clear()
            if self._stop.is_set():
                break
            try:
                while send_due(self._db) == BATCH:
                    pass  # a backlog goes out in batches
            except Exception:  # noqa: BLE001 - scrobbling must never take the app down
                log.exception("Sending listens failed")
