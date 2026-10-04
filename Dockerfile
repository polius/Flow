# Flow — single container, single port.

# ---- Stage 1: frontend build ------------------------------------------------
FROM node:26-alpine AS frontend
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
# tini: PID 1 signal handling. bash: the start script uses `wait -n`
# and pipefail — kept on real bash for predictability, not busybox ash.
# ffmpeg: scan-time loudness analysis; its absence degrades gracefully —
# tracks just play at unity gain.
# su-exec: start.sh runs as root just long enough to prepare a root-owned
# bind mount, then re-execs the servers as the unprivileged app user.
RUN apk add --no-cache nginx tini bash ffmpeg su-exec \
 && addgroup -g 1000 flow \
 && adduser -D -u 1000 -G flow flow

WORKDIR /app
COPY --from=backend /opt/venv /opt/venv
COPY --from=frontend /build/dist /app/static
COPY backend/app /app/app
COPY nginx/default.conf /app/nginx.conf
COPY docker/start.sh /app/start.sh

RUN chmod +x /app/start.sh \
 && mkdir -p /flow/music /flow/data /tmp/nginx \
 && chown -R flow:flow /app /flow /tmp/nginx

# No USER directive: the container starts as root so start.sh can prepare
# a bind-mounted /flow whose host directory is root-owned (NAS shares
# usually are). A bind mount shadows the /flow dirs created above, and a
# plain non-root container can't mkdir inside such a mount. Once the
# writable dirs are in place, start.sh drops to flow:flow — nginx and
# uvicorn never run as root. An explicit `docker run --user …` skips all
# of this and runs directly as that user, files stay owned by flow (1000,
# the host's first user on typical Linux installs).
ENV PATH="/opt/venv/bin:$PATH" \
    FLOW_MUSIC_DIR=/flow/music \
    FLOW_DATA_DIR=/flow/data \
    FLOW_DIST_DIR=/app/static \
    FLOW_STREAM_MODE=nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
