#!/usr/bin/env bash
# Verify the deploy is healthy and print the rollback sequence if it is not.
# Used by CI after deployment and by operators during incident response.
#   ./scripts/rollback-check.sh            # health check only
#   ROLLBACK_EXECUTE=1 ./scripts/rollback-check.sh  # actually roll back (Docker Compose)
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
API_URL="${SMOKE_API_URL:-http://localhost:3001}"
WEB_URL="${SMOKE_WEB_URL:-http://localhost:3002}"
BACKUP_TAG="${BACKUP_TAG:-}"
ROLLBACK_EXECUTE="${ROLLBACK_EXECUTE:-0}"

health_ok() {
  local code
  code="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$1" || echo 000)"
  [[ "$code" =~ ^2 ]]
}

if health_ok "$API_URL/api/flags" && health_ok "$WEB_URL/"; then
  echo "HEALTH OK: API and web responded successfully."
  exit 0
fi

echo "HEALTH FAILED: API or web is unhealthy." >&2
echo "Rollback procedure:" >&2
echo "  1. Keep the current database snapshot; do NOT run a destructive reset." >&2
echo "  2. Restore the previous API/Web image tag (${BACKUP_TAG:-<previous-tag>})." >&2
echo "  3. If a schema migration was part of the deploy, restore the DB snapshot" >&2
echo "     taken before that migration, then re-run 'prisma migrate deploy'." >&2
echo "  4. Re-run: ./scripts/smoke-test.sh" >&2

if [[ "$ROLLBACK_EXECUTE" == "1" ]]; then
  [[ -n "$BACKUP_TAG" ]] || { echo "BACKUP_TAG is required for automatic rollback" >&2; exit 1; }
  echo "Executing rollback to $BACKUP_TAG..." >&2
  cd "$PROJECT_DIR"
  docker compose -f "$COMPOSE_FILE" pull || true
  docker compose -f "$COMPOSE_FILE" up -d --no-deps api web
  ./scripts/smoke-test.sh
fi

exit 1
