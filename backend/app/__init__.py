"""Flow — the application version lives here, once.

The FastAPI app (OpenAPI docs, /api/health) reads this value, and the
frontend fetches it back through the API, so the two can never drift.
"""

__version__ = "1.4.0"
