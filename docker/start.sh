#!/usr/bin/env bash
set -euo pipefail

# The container starts as root (see Dockerfile) so a root-owned bind mount
# — NAS shares usually are — can be prepared: a mount shadows the dirs the
# image created, and a non-root process couldn't mkdir inside it. Only the
# app-writable dirs are touched; the music library keeps its host ownership
# (the app only ever reads it). Then drop everything below to flow:flow.
# An explicit `docker run --user …` skips this block and runs as-is.
if [ "$(id -u)" = "0" ]; then
    mkdir -p "$FLOW_MUSIC_DIR" "$FLOW_DATA_DIR"
    chown -R flow:flow "$FLOW_DATA_DIR"
    exec su-exec flow:flow "$0"
fi

nginx -e stderr -c /app/nginx.conf -g 'daemon off;' &
nginx_pid=$!

cd /app
uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log &
uvicorn_pid=$!

on_term() {
    kill -TERM "$nginx_pid" "$uvicorn_pid" 2>/dev/null || true
}
trap on_term TERM INT

set +e
wait -n "$nginx_pid" "$uvicorn_pid"
status=$?
on_term
wait
exit "$status"
