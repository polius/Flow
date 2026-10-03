#!/usr/bin/env bash
# Flow container entrypoint (DESIGN.md §10).
#
# tini (PID 1) signals this script; we forward SIGTERM to both children and
# exit as soon as EITHER dies (`wait -n`) so a dead API can never keep
# serving static files, and `docker stop` is graceful, never hard-kill.
set -euo pipefail

# -e: nginx opens its compile-time default error log (/var/lib/nginx/logs/)
# *before* parsing any config, which the flow user cannot write. Point that
# pre-config log at stderr too (§10: everything logs to the container stream).
nginx -e /dev/stderr -c /app/nginx.conf -g 'daemon off;' &
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
