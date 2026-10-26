"""Helpers shared by the routers: the per-request transaction guard, paging, LIKE escaping, chunking, timestamps."""

from __future__ import annotations

import functools
import inspect
from datetime import datetime, timezone

from fastapi.routing import APIRoute

from app.db import rollback_thread_connections

DEFAULT_LIMIT = 200
MAX_LIMIT = 1000

# Search/filter query strings are capped like the JSON bodies (schemas.py).
MAX_QUERY = 500


class TxRoute(APIRoute):
    """Route that rolls back the worker thread's open transaction when the
    endpoint returns or raises.

    Sync endpoints run in a threadpool thread and use that thread's
    connection; an exception between a write and its commit would otherwise
    leave the transaction open — holding SQLite's write lock (every other
    connection then sees "database is locked") and letting the half-done
    writes ride into whatever the next request on that thread commits. The
    wrapper runs in the same thread as the endpoint, which a middleware or a
    yield-dependency can't guarantee.
    """

    def __init__(self, path: str, endpoint, **kwargs) -> None:
        if not inspect.iscoroutinefunction(endpoint) and not getattr(
            endpoint, "_flow_tx", False
        ):
            inner = endpoint

            @functools.wraps(inner)
            def endpoint(*args, **kw):
                try:
                    return inner(*args, **kw)
                finally:
                    rollback_thread_connections()

            endpoint._flow_tx = True
        super().__init__(path, endpoint, **kwargs)


def clamp_page(limit: int, offset: int) -> tuple[int, int]:
    return min(max(limit, 1), MAX_LIMIT), max(offset, 0)


def like_pattern(term: str) -> str:
    """Escape LIKE wildcards in user input."""
    return f"%{term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')}%"


def chunks(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()
