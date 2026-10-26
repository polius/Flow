#!/usr/bin/env bash
# Smoke-test a running Flow container started with DEMO=true:
#   .github/scripts/smoke-test.sh [base-url]
# Checks health, a ranged audio stream through nginx, the security headers,
# and the login rate limit. Needs curl and python3.
set -euo pipefail

base="${1:-http://127.0.0.1:8080}"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# Response headers of a GET, body discarded.
headers() { curl -fsS -o /dev/null -D - "$@" | tr -d "\r"; }

# --- Health ---------------------------------------------------------------
healthy=
for _ in $(seq 60); do
    if curl -fsS "$base/api/health" >/dev/null 2>&1; then healthy=1; break; fi
    sleep 2
done
[ -n "$healthy" ] || fail "/api/health never returned 200"
ok "health"

# --- Demo library + ranged stream -----------------------------------------
track=
for _ in $(seq 60); do
    track=$(curl -fsS "$base/api/tracks?limit=1" \
        | python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; print(items[0]["id"] if items else "")')
    [ -n "$track" ] && break
    sleep 2
done
[ -n "$track" ] || fail "the demo library never appeared"
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-1023' "$base/api/stream/$track")
[ "$code" = 206 ] || fail "ranged stream of track $track returned $code, expected 206"
ok "range stream (track $track) -> 206"

# --- Security headers -----------------------------------------------------
page=$(headers "$base/")
for expected in \
    "x-content-type-options: nosniff" \
    "referrer-policy: same-origin" \
    "x-frame-options: DENY"; do
    grep -qiF "$expected" <<<"$page" || fail "/ is missing '$expected'"
done
csp=$(grep -i '^content-security-policy:' <<<"$page") || fail "/ has no Content-Security-Policy"
grep -qF "frame-ancestors 'none'" <<<"$csp" || fail "CSP lacks frame-ancestors 'none'"
if grep -qF "__INLINE_SCRIPT_HASHES__" <<<"$csp"; then fail "CSP still has the build placeholder"; fi
# Every inline script the page ships must be allowed by hash.
curl -fsS "$base/" | python3 -c '
import base64, hashlib, re, sys
csp = sys.argv[1]
for body in re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", sys.stdin.read(), re.S):
    h = "sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    if h not in csp:
        sys.exit(f"FAIL: inline script {h} is not in the CSP")
' "$csp"
server=$(grep -i '^server:' <<<"$page" || true)
if grep -q "[0-9]" <<<"$server"; then fail "Server header leaks a version: $server"; fi
ok "security headers on /"

api=$(headers "$base/api/health")
grep -qiF "x-content-type-options: nosniff" <<<"$api" || fail "/api/health lacks nosniff"
[ "$(grep -ci '^x-content-type-options:' <<<"$api")" = 1 ] || fail "/api/health sends nosniff twice"
ok "security headers on /api"

asset=$(curl -fsS "$base/" | grep -o '/assets/[^"]*\.js' | head -n1)
[ -n "$asset" ] || fail "no /assets/ script in index.html"
[ "$(headers "$base$asset" | grep -ci '^cache-control:')" = 1 ] || fail "$asset sends more than one Cache-Control"
ok "one Cache-Control on $asset"

# --- Rate limit: page loads never throttled, login bursts are -------------
for _ in $(seq 20); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/auth/status")
    if [ "$code" = 429 ]; then fail "/api/auth/status was rate limited"; fi
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$base/")
    if [ "$code" = 429 ]; then fail "/ was rate limited"; fi
done
limited=
for _ in $(seq 12); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
        -d '{"password":"wrong-password"}' "$base/api/auth/login")
    if [ "$code" = 429 ]; then limited=1; break; fi
done
[ -n "$limited" ] || fail "a burst of logins was never rate limited"
ok "rate limit: status/page loads pass, login burst gets 429"

echo "smoke test passed"
