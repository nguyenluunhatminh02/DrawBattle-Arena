#!/usr/bin/env bash
set -euo pipefail

DB="docker exec drawbattle-db psql -U drawbattle -d drawbattle -t -A -c"

echo "=== Scoring / Leave / Ready Verification ==="

ss -tlnp | grep -q ':3001' && echo "API :3001 OK" || { echo "API down"; exit 1; }
ss -tlnp | grep -q ':3002' && echo "Web :3002 OK" || { echo "Web down"; exit 1; }

GUESS_COUNT=$($DB "SELECT COUNT(*) FROM guesses WHERE received_at > NOW() - INTERVAL '1 hour';")
HIGH_SCORES=$($DB "SELECT COUNT(*) FROM scores WHERE points > 0 AND updated_at > NOW() - INTERVAL '1 hour';")
MATCH_COUNT=$($DB "SELECT COUNT(*) FROM matches WHERE ended_at > NOW() - INTERVAL '1 hour';")
LEFT_COUNT=$($DB "SELECT COUNT(*) FROM room_players WHERE left_at IS NOT NULL;")

echo "Guesses (1h):      $GUESS_COUNT"
echo "Scores > 0 (1h):   $HIGH_SCORES"
echo "Matches (1h):      $MATCH_COUNT"
echo "Players left (all):$LEFT_COUNT"

echo ""
echo "Run full checks:"
echo "  node apps/web/socket-leave-e2e.mjs        # ready-gating + leave + host transfer"
echo "  node apps/web/socket-room-e2e.mjs         # password/settings/rejoin/full match"
echo "  cd apps/web && npx playwright test e2e/room-ux.spec.ts --workers=1   # QR join + mobile"
