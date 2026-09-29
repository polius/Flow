# Flow — single container, single port (DESIGN.md §10).
#
#   Stage 1  node:22-alpine    → npm ci && vite build
#   Stage 2  python:3.13-alpine → venv + dependency cleanup
#   Stage 3  python:3.13-alpine → runtime: uvicorn + nginx + static, non-root
#
# Alpine base (owner decision, 2026-09-29 — supersedes the earlier §10.4
# Debian-slim choice): all runtime deps ship musl wheels, and the measured
# slim premium was ~135MB, not the ~40MB the original estimate assumed.

# ---- Stage 1: frontend build ------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: python dependencies -------------------------------------------
FROM python:3.13-alpine AS backend
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY backend/requirements.txt ./
# musl wheels exist for every dep (mutagen/watchdog pure, pydantic-core
# publishes musllinux) — no compiler in the image.
RUN pip install --no-cache-dir -r requirements.txt \
 && pip uninstall -y pip \
 && find /opt/venv -type d \( -name "__pycache__" -o -name "tests" \) -exec rm -rf {} + 2>/dev/null; \
    find /opt/venv -name "*.pyc" -delete

# ---- Stage 3: runtime --------------------------------------------------------
FROM python:3.13-alpine AS runtime
# tini: PID 1 signal handling (§10.1). bash: the start script uses `wait -n`
# and pipefail — kept on real bash for predictability, not busybox ash.
RUN apk add --no-cache nginx tini bash \
 && adduser -D -u 1000 flow

WORKDIR /app
COPY --from=backend /opt/venv /opt/venv
COPY --from=frontend /build/dist /app/static
COPY backend/app /app/app
COPY nginx/default.conf /app/nginx.conf
COPY docker/start.sh /app/start.sh

RUN chmod +x /app/start.sh \
 && mkdir -p /data /music /tmp/nginx \
 && chown -R flow:flow /app /data /tmp/nginx

USER flow
ENV PATH="/opt/venv/bin:$PATH" \
    FLOW_MUSIC_DIR=/music \
    FLOW_DATA_DIR=/data \
    FLOW_DIST_DIR=/app/static \
    FLOW_STREAM_MODE=nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
