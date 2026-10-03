#!/usr/bin/env bash
set -euo pipefail

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
