#!/usr/bin/env bash
# Post-deploy smoke + health verification for DrawBattle.
# Usage: SMOKE_API_URL=https://api.example.com SMOKE_WEB_URL=https://example.com ./scripts/smoke-test.sh
# `SMOKE_ROLLBACK_URL` (optional) is pinged only when the main checks fail;
# CI/ops can use that signal to trigger a rollback playbook.
set -euo pipefail

API_URL="${SMOKE_API_URL:-http://localhost:3001}"
WEB_URL="${SMOKE_WEB_URL:-http://localhost:3002}"
TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-10}"
ATTEMPTS="${SMOKE_ATTEMPTS:-12}"
ROLLBACK_URL="${SMOKE_ROLLBACK_URL:-}"

fail() {
  echo "SMOKE FAILED: $*" >&2
  if [[ -n "$ROLLBACK_URL" ]]; then
    echo "Notifying rollback endpoint..." >&2
    curl -fsS -X POST "$ROLLBACK_URL" >/dev/null 2>&1 || true
  fi
  exit 1
}

http_status() {
  curl -sS --max-time "$TIMEOUT_SECONDS" -o /dev/null -w '%{http_code}' "$1" || echo 000
}

echo "== DrawBattle post-deploy smoke =="
echo "API: $API_URL"
echo "Web: $WEB_URL"

# 1. Web serves the application shell.
for attempt in $(seq 1 "$ATTEMPTS"); do
  code="$(http_status "$WEB_URL/")"
  if [[ "$code" =~ ^2 ]]; then
    echo "web health OK ($code)"
    break
  fi
  [[ "$attempt" -eq "$ATTEMPTS" ]] && fail "web did not become healthy (last status $code)"
  sleep 3
done

# 2. API flags endpoint is the deployed liveness probe.
for attempt in $(seq 1 "$ATTEMPTS"); do
  code="$(http_status "$API_URL/api/flags")"
  if [[ "$code" =~ ^2 ]]; then
    echo "api health OK ($code)"
    break
  fi
  [[ "$attempt" -eq "$ATTEMPTS" ]] && fail "api did not become healthy (last status $code)"
  sleep 3
done

# 3. Guest identity + room persistence round-trip.
guest_response="$(curl -sS --max-time "$TIMEOUT_SECONDS" -X POST "$API_URL/api/guest-sessions" \
  -H 'Content-Type: application/json' \
  -d '{"nickname":"SmokeProbe"}' || true)"
token="$(printf '%s' "$guest_response" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{process.stdout.write("")}})')"
[[ -n "$token" ]] || fail "guest session creation failed: $guest_response"
echo "guest identity OK"

room_response="$(curl -sS --max-time "$TIMEOUT_SECONDS" -X POST "$API_URL/api/rooms" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $token" \
  -d '{"settings":{"mode":"CLASSIC","rounds":1,"maxPlayers":4}}' || true)"
room_code="$(printf '%s' "$room_response" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).roomCode||"")}catch{process.stdout.write("")}})')"
[[ -n "$room_code" ]] || fail "room creation failed: $room_response"
echo "room create OK ($room_code)"

info_code="$(http_status "$API_URL/api/rooms/$room_code")"
[[ "$info_code" =~ ^2 ]] || fail "room info lookup failed ($info_code)"
echo "room persistence OK"

# 4. Public match history must respond (privacy regression guard).
matches_code="$(http_status "$API_URL/api/matches?limit=5")"
[[ "$matches_code" =~ ^2 ]] || fail "match history failed ($matches_code)"
echo "match history OK"

echo "SMOKE PASSED"
