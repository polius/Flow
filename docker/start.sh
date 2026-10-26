#!/usr/bin/env bash
set -euo pipefail

# The container starts as root (see Dockerfile) so a root-owned bind mount
# — NAS shares usually are — can be prepared: a mount shadows the dirs the
# image created, and a non-root process couldn't mkdir inside it. Only the
# app-writable dirs are touched; the music library keeps its host ownership
# and permissions (the app only ever reads it). Then drop everything below
# to PUID:PGID (default 1000:1000, the image's flow user).
# An explicit `docker run --user …` skips this block and runs as-is.
if [ "$(id -u)" = "0" ]; then
    PUID="${PUID:-1000}"
    PGID="${PGID:-1000}"
    case "$PUID:$PGID" in
        *[!0-9:]* | :* | *:) echo "PUID/PGID must be numeric (got '$PUID:$PGID')" >&2; exit 1 ;;
    esac
    if [ "$PUID" = "0" ]; then
        echo "PUID=0 is not supported: Flow never runs its servers as root." >&2
        exit 1
    fi

    mkdir -p "$FLOW_MUSIC_DIR"
    # From here on, new files are private to the app user: the database
    # holds the password hash and session tokens.
    umask 077
    mkdir -p "$FLOW_DATA_DIR"
    # Re-own and tighten only what needs it, so a large data dir costs
    # nothing on a normal boot. This also converts a data dir written by an
    # older release (owned by 1000, files 0644) to the current PUID and
    # owner-only modes. The music folder is skipped even if it is mounted
    # inside the data dir.
    find "$FLOW_DATA_DIR" -path "$FLOW_MUSIC_DIR" -prune -o \
        \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
    find "$FLOW_DATA_DIR" -path "$FLOW_MUSIC_DIR" -prune -o \
        ! -type l -perm /077 -exec chmod go-rwx {} +
    chown -R "$PUID:$PGID" /tmp/nginx
    exec su-exec "$PUID:$PGID" "$0"
fi

umask 077

# Say so loudly when the library can't be read: a private NAS share
# otherwise just shows up as an empty library.
if ! ls "$FLOW_MUSIC_DIR" >/dev/null 2>&1; then
    echo "WARNING: the music folder ($FLOW_MUSIC_DIR) is not readable by uid $(id -u), gid $(id -g)." >&2
    echo "WARNING: the library will look empty. Set PUID/PGID to a user that can read it, or grant read access on the host." >&2
fi

# Behind a reverse proxy, FLOW_TRUSTED_PROXIES (addresses or CIDRs,
# comma- or space-separated) makes nginx take the client address from
# X-Forwarded-For when the request comes from one of them.
realip=/tmp/nginx/realip.conf
: > "$realip"
IFS=', ' read -r -a proxies <<< "${FLOW_TRUSTED_PROXIES:-}"
for proxy in "${proxies[@]}"; do
    case "$proxy" in
        *[!0-9A-Fa-f.:/]*) echo "FLOW_TRUSTED_PROXIES: ignoring '$proxy' (not an address or CIDR)" >&2; continue ;;
    esac
    echo "set_real_ip_from $proxy;" >> "$realip"
done
if [ -s "$realip" ]; then
    printf 'real_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n' >> "$realip"
fi

nginx -e stderr -c /app/nginx/default.conf -g 'daemon off;' &
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
