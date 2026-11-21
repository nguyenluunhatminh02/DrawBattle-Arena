#!/usr/bin/env bash
# Local, CI-equivalent verification for DrawBattle.
# Runs the same checks as .github/workflows/ci.yml and writes a plain-text
# evidence file that can be attached to a portfolio, issue or pull request.
#
# Usage (no services / no database required):
#   ./scripts/verify-local-ci.sh
#
# Usage (full CI parity with local service containers):
#   docker compose up -d postgres redis
#   DATABASE_URL='postgresql://drawbattle:drawbattle@localhost:5440/drawbattle?schema=public' \
#   REDIS_URL='redis://localhost:6390' \
#   JWT_SECRET='ci-test-secret-with-at-least-32-chars' \
#   E2E_API_URL='http://localhost:3001' \
#   E2E_WEB_URL='http://localhost:3002' \
#   ./scripts/verify-local-ci.sh
#
# Optional environment variables:
#   VERIFY_EVIDENCE_FILE   output path (default: artifacts/local-ci-evidence-<UTC timestamp>.txt)
#   VERIFY_PNPM            pnpm command to use (default: pnpm; CI uses pnpm 9 via pnpm/action-setup)
#   VERIFY_SKIP_AUDIT=1    skip the audit step (CI does not run it; default: run pnpm audit --prod --audit-level=high)
#   VERIFY_ALLOW_AUDIT_VULNS=1  do not fail the overall result when audit reports known advisories
#   SKIP_E2E_STARTUP=1     do not start API/Web from this script (use when services are already running)
#   PLAYWRIGHT_INSTALL=0   skip `playwright install chromium` (default: install when E2E runs)
#   PLAYWRIGHT_WITH_DEPS=0 skip OS dependencies during Playwright install (default: install with deps)
#
# Notes:
#   * On hosts with pnpm 10/11/12, package.json `pnpm.overrides` is no longer read.
#     Pin VERIFY_PNPM to a pnpm 9 command (for example a Docker wrapper) for a
#     byte-for-byte CI dependency install; see docs/local-ci-verification.md.
#   * Migrations, seed and integration/E2E checks are skipped when DATABASE_URL /
#     REDIS_URL / E2E URLs are absent. Skips are recorded in the evidence file;
#     they are not reported as passes.
#   * The script never pushes to GitHub. It cannot fix a locked/billing-blocked
#     GitHub account; it produces locally verifiable evidence instead.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_FILE="${VERIFY_EVIDENCE_FILE:-$REPO_ROOT/artifacts/local-ci-evidence-$TIMESTAMP.txt}"
PNPM="${VERIFY_PNPM:-pnpm}"
CI_URL="https://github.com/nguyenluunhatminh02/DrawBattle-Arena/actions"
mkdir -p "$(dirname "$EVIDENCE_FILE")"
: >"$EVIDENCE_FILE"

REDACT_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/redact-secrets.XXXXXX.py")"
cat > "$REDACT_SCRIPT" <<'PYEOF'
import sys, re

# Matches API_KEY, AUTH, TOKEN, SECRET, CREDENTIAL, SESSION and COOKIE in
# camelCase, snake_case, kebab-case or bare form.
SENSITIVE_KEY = r'(?:[A-Za-z_][A-Za-z0-9_.-]*?(?:TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|AUTH|CREDENTIAL|SESSION|COOKIE)|(?:AUTH|SESSION|COOKIE|TOKEN|CREDENTIAL|API[_-]?KEY|PASSWORD|PASSWD|SECRET)[A-Za-z0-9_.-]*|[A-Za-z_][A-Za-z0-9_.-]*?KEY)'

url_query_re = re.compile(r'(?i)([?&])' + SENSITIVE_KEY + r'=([^&\s"\'\)\]\}>]*)')
inline_re = re.compile(r'(?i)(\b' + SENSITIVE_KEY + r'\s*=\s*)(?:"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[^\s,;}\]]+)')
userinfo_re = re.compile(r'([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@')
json_field_re = re.compile(r'(?i)(["\']' + SENSITIVE_KEY + r'["\']\s*:\s*)(?:"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[^\s,;}\]]+)')
bearer_re = re.compile(r'(?i)(\bbearer\s+)([^\s"\',}\]]+)')
word_secret_re = re.compile(r'(?i)\b(secret|token|password|passwd|api[_-]?key|credential|session|cookie)\s+([^\s,;}\]]+)')

def redact(text):
    text = userinfo_re.sub(r'\1<redacted>@', text)
    text = url_query_re.sub(lambda m: m.group(1) + m.group(0)[len(m.group(1)):].split('=', 1)[0] + '=<redacted>', text)
    text = inline_re.sub(r'\1<redacted>', text)
    text = json_field_re.sub(r'\1<redacted>', text)
    text = word_secret_re.sub(r'\1 <redacted>', text)
    text = bearer_re.sub(r'\1<redacted>', text)
    return text

for line in sys.stdin:
    sys.stdout.write(redact(line))
PYEOF

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILURE_LIST=()
API_PID=""
WEB_PID=""

log() {
  local message="$*"
  printf '%s\n' "$message" | tee -a "$EVIDENCE_FILE"
}

record() {
  local status="$1"
  local name="$2"
  local detail="${3:-}"
  local line
  if [[ -n "$detail" ]]; then
    line="[$status] $name - $detail"
  else
    line="[$status] $name"
  fi
  log "$line"
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    FAIL)
      FAIL_COUNT=$((FAIL_COUNT + 1))
      FAILURE_LIST+=("$name: $detail")
      ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
  esac
}

# Record presence only; never expand a sensitive variable into the evidence file.
mask() {
  if [[ -n "${!1:-}" ]]; then
    printf 'set'
  else
    printf 'unset'
  fi
}

is_sensitive_env_name() {
  case "${1^^}" in
    *JWT_SECRET|*DATABASE_URL|*REDIS_URL|*TOKEN*|*PASSWORD*|*PASSWD*|*SECRET*|*API_KEY*|*API-KEY*|*AUTH*|*CREDENTIAL*|*SESSION*|*COOKIE*) return 0 ;;
    *) return 1 ;;
  esac
}

redact_line() {
  python3 "$REDACT_SCRIPT" <<<"$1"
}

# Streaming filter for long-lived subprocesses (API/web startup logs).
redact_subprocess_output() {
  while IFS= read -r line || [[ -n "$line" ]]; do
    redact_line "$line" | tee -a "$EVIDENCE_FILE"
  done
}

# Display-only copy of a command. Sensitive inline KEY=value arguments,
# userinfo and secrets in URL query strings, JSON fields and bearer tokens are
# replaced with <redacted>; the real "$@" is still executed unchanged.
redact_command_display() {
  local arg name value
  local -a parts=()
  for arg in "$@"; do
    if [[ "$arg" == *=* ]]; then
      name="${arg%%=*}"
      value="${arg#*=}"
      if is_sensitive_env_name "$name"; then
        parts+=("$name=<redacted>")
      else
        parts+=("$(redact_line "$arg")")
      fi
      continue
    fi
    parts+=("$(redact_line "$arg")")
  done
  printf '%s' "${parts[*]}"
}

# Every subprocess output line passes through the same display filter before it
# reaches stdout or the evidence file. The background process keeps the real
# command's PID so its exit status is still reported accurately.
run_step() {
  local name="$1"
  shift
  log ""
  log "=== $name ==="
  log "+ $(redact_command_display "$@")"
  "$@" > >(redact_subprocess_output) 2>&1 &
  local status=0
  wait "$!" || status=$?
  if (( status == 0 )); then
    record PASS "$name" "exit=0"
    return 0
  fi
  record FAIL "$name" "exit=$status"
  return 1
}

skip_step() {
  record SKIP "$1" "$2"
}

is_set() {
  local value="${!1:-}"
  [[ -n "$value" && "$value" != "0" && "$value" != "false" ]]
}

cleanup() {
  local pid
  for pid in "$API_PID" "$WEB_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  log ""
  log "Cleanup: stopped locally started API/Web processes (if any)."
}
cleanup_and_remove_redactor() {
  cleanup
  rm -f "$REDACT_SCRIPT"
}
trap cleanup_and_remove_redactor EXIT

log "DrawBattle local CI-equivalent verification"
log "Started (UTC): $TIMESTAMP"
log "Repository: $REPO_ROOT"
log "Commit: $(git rev-parse HEAD 2>/dev/null || echo unavailable)"
log "Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unavailable)"
log "Node: $(node --version 2>&1 | redact_line || echo unavailable)"
log "pnpm: $PNPM ($($PNPM --version 2>&1 | redact_line || echo unavailable))"
log "CI workflow: .github/workflows/ci.yml"
log "CI run #51 (f67719e): $CI_URL/runs/44870295188"
log "Evidence file: $EVIDENCE_FILE"
log ""
log "Environment:"
log "  DATABASE_URL=$(mask DATABASE_URL)"
log "  REDIS_URL=$(mask REDIS_URL)"
log "  JWT_SECRET=$(mask JWT_SECRET)"
log "  E2E_API_URL=$(mask E2E_API_URL)"
log "  E2E_WEB_URL=$(mask E2E_WEB_URL)"
log "  VERIFY_PNPM=$PNPM"
log "Note: only presence is recorded for DATABASE_URL, REDIS_URL and JWT_SECRET; their values are never printed."

# 1. Install dependencies (CI: pnpm install --frozen-lockfile).
if ! run_step "install" env CI=true "$PNPM" install --frozen-lockfile; then
  log "Install failed; later steps that need workspace binaries will likely fail too."
fi

# 2. Build shared (CI: pnpm --filter @drawbattle/shared build).
run_step "shared-build" env CI=true "$PNPM" --filter @drawbattle/shared build || true

# 3. Prisma generate (CI: pnpm --filter @drawbattle/api exec prisma generate).
run_step "prisma-generate" env CI=true "$PNPM" --filter @drawbattle/api exec prisma generate || true

# 4. Prisma migrations + seed. CI provisions PostgreSQL/Redis as service
# containers; locally they must be started by the caller (e.g. docker compose).
if is_set DATABASE_URL; then
  run_step "prisma-migrate-deploy" env CI=true DATABASE_URL="$DATABASE_URL" \
    "$PNPM" --filter @drawbattle/api exec prisma migrate deploy || true
  run_step "prisma-db-seed" env CI=true DATABASE_URL="$DATABASE_URL" \
    "$PNPM" --filter @drawbattle/api db:seed || true
else
  skip_step "prisma-migrate-deploy" "DATABASE_URL not set"
  skip_step "prisma-db-seed" "DATABASE_URL not set"
fi

# 5. Typecheck (CI: pnpm -r typecheck).
run_step "typecheck" env CI=true "$PNPM" -r typecheck || true

# 6. Unit tests (CI: pnpm --filter @drawbattle/api test).
run_step "unit-tests" env CI=true "$PNPM" --filter @drawbattle/api test || true

# 7. Integration tests (CI: PostgreSQL + Redis service containers).
if is_set DATABASE_URL && is_set REDIS_URL; then
  run_step "integration-tests" env CI=true \
    DATABASE_URL="$DATABASE_URL" \
    REDIS_URL="$REDIS_URL" \
    JWT_SECRET="${JWT_SECRET:-local-ci-secret-with-at-least-32-chars}" \
    "$PNPM" --filter @drawbattle/api test:integration || true
else
  skip_step "integration-tests" "DATABASE_URL and/or REDIS_URL not set"
fi

# 8. Clean migration check (CI: second deploy + status on an already migrated DB).
if is_set DATABASE_URL; then
  run_step "clean-migration-check" env CI=true DATABASE_URL="$DATABASE_URL" bash -c '
    set -e
    "$0" --filter @drawbattle/api exec prisma migrate deploy
    "$0" --filter @drawbattle/api exec prisma migrate status
  ' "$PNPM" || true
else
  skip_step "clean-migration-check" "DATABASE_URL not set"
fi

# 9. API and web builds (CI: pnpm --filter @drawbattle/{api,web} build).
run_step "api-build" env CI=true "$PNPM" --filter @drawbattle/api build || true
run_step "web-build" env CI=true "$PNPM" --filter @drawbattle/web build || true

# 10. Production dependency audit (not part of ci.yml, included as local evidence).
if [[ "${VERIFY_SKIP_AUDIT:-0}" == "1" ]]; then
  skip_step "dependency-audit" "VERIFY_SKIP_AUDIT=1"
else
  if run_step "dependency-audit" env CI=true "$PNPM" audit --prod --audit-level=high; then
    :
  elif [[ "${VERIFY_ALLOW_AUDIT_VULNS:-0}" == "1" ]]; then
    record SKIP "dependency-audit-result" "advisories reported; VERIFY_ALLOW_AUDIT_VULNS=1"
  else
    log "Audit advisory details are included above; set VERIFY_ALLOW_AUDIT_VULNS=1 to treat known advisories as informational."
  fi
fi

# 11. Playwright e2e (CI: builds, starts API/Web, installs chromium, runs suite,
# smoke test, then stops services). Requires E2E URLs to opt in.
if is_set E2E_API_URL && is_set E2E_WEB_URL; then
  export E2E_API_URL E2E_WEB_URL
  if [[ "${SKIP_E2E_STARTUP:-0}" != "1" ]]; then
    if is_set DATABASE_URL && is_set REDIS_URL; then
      log ""
      log "=== start-e2e-services ==="
      # Startup logs are routed through the same redaction filter as all other
      # subprocess output; the services themselves keep their real arguments.
      log "+ $(redact_command_display env CI=true DATABASE_URL="$DATABASE_URL" \
        REDIS_URL="$REDIS_URL" \
        JWT_SECRET="${JWT_SECRET:-local-ci-secret-with-at-least-32-chars}" \
        CORS_ORIGIN="$E2E_WEB_URL" \
        PORT=3001 \
        TRUST_PROXY=1 \
        "$PNPM" --filter @drawbattle/api start)"
      env CI=true \
        DATABASE_URL="$DATABASE_URL" \
        REDIS_URL="$REDIS_URL" \
        JWT_SECRET="${JWT_SECRET:-local-ci-secret-with-at-least-32-chars}" \
        CORS_ORIGIN="$E2E_WEB_URL" \
        PORT=3001 \
        TRUST_PROXY=1 \
        "$PNPM" --filter @drawbattle/api start > >(redact_subprocess_output) 2>&1 &
      API_PID=$!
      log "+ $(redact_command_display env CI=true \
        NEXT_PUBLIC_API_URL="$E2E_API_URL" \
        INTERNAL_API_URL="$E2E_API_URL" \
        PORT=3002 \
        "$PNPM" --filter @drawbattle/web start)"
      env CI=true \
        NEXT_PUBLIC_API_URL="$E2E_API_URL" \
        INTERNAL_API_URL="$E2E_API_URL" \
        PORT=3002 \
        "$PNPM" --filter @drawbattle/web start > >(redact_subprocess_output) 2>&1 &
      WEB_PID=$!

      # CI waits for API /api/flags and the web root before running Playwright.
      local ready=0 attempt
      for attempt in $(seq 1 60); do
        if curl -sf "$E2E_API_URL/api/flags" >/dev/null 2>&1 && curl -sf "$E2E_WEB_URL/" >/dev/null 2>&1; then
          ready=1
          break
        fi
        sleep 2
      done
      if [[ "$ready" == "1" ]]; then
        record PASS "start-e2e-services" "api_pid=$API_PID web_pid=$WEB_PID; services ready"
      else
        record FAIL "start-e2e-services" "API/web did not become ready within 120s"
        log "See API/web startup output above in this evidence file."
      fi
    else
      skip_step "start-e2e-services" "DATABASE_URL/REDIS_URL not set; set SKIP_E2E_STARTUP=1 if services are already running"
    fi
  else
    skip_step "start-e2e-services" "SKIP_E2E_STARTUP=1"
  fi

  if [[ "${PLAYWRIGHT_INSTALL:-1}" != "0" ]]; then
    if [[ "${PLAYWRIGHT_WITH_DEPS:-1}" == "1" ]]; then
      run_step "playwright-install" env CI=true "$PNPM" --filter @drawbattle/web exec playwright install --with-deps chromium || true
    else
      run_step "playwright-install" env CI=true "$PNPM" --filter @drawbattle/web exec playwright install chromium || true
    fi
  else
    skip_step "playwright-install" "PLAYWRIGHT_INSTALL=0"
  fi

  run_step "playwright-e2e" env CI=true "$PNPM" --filter @drawbattle/web test:e2e || true
  # run_step now filters every subprocess through the shared redactor, including
  # the smoke script's echoed URLs and any JSON failure payloads it prints.
  run_step "post-deploy-smoke" env CI=true \
    SMOKE_API_URL="$E2E_API_URL" \
    SMOKE_WEB_URL="$E2E_WEB_URL" \
    bash "$REPO_ROOT/scripts/smoke-test.sh" || true
else
  skip_step "playwright-install" "E2E_API_URL/E2E_WEB_URL not set"
  skip_step "playwright-e2e" "E2E_API_URL/E2E_WEB_URL not set"
  skip_step "post-deploy-smoke" "E2E_API_URL/E2E_WEB_URL not set"
fi

log ""
log "=== Summary ==="
log "PASS: $PASS_COUNT"
log "FAIL: $FAIL_COUNT"
log "SKIP: $SKIP_COUNT"
if (( FAIL_COUNT > 0 )); then
  log "Failed steps:"
  for failure in "${FAILURE_LIST[@]}"; do
    log "  - $failure"
  done
  log "RESULT: FAILED (see details above; attach this file as local CI evidence)."
  exit 1
fi
log "RESULT: PASSED WITH SKIPS (see SKIP lines; attach this file as local CI evidence)."
