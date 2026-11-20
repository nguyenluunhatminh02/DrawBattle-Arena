#!/usr/bin/env bash
set -euo pipefail

echo "=== Scoring Fix Verification ==="
echo ""

# 1. Check API is running
echo "1. Checking API..."
if ss -tlnp | grep -q ':3001'; then
  echo "   ✅ API running on :3001"
else
  echo "   ❌ API not running"
  exit 1
fi

# 2. Check Web is running
echo "2. Checking Web..."
if ss -tlnp | grep -q ':3002'; then
  echo "   ✅ Web running on :3002"
else
  echo "   ❌ Web not running"
  exit 1
fi

# 3. API health
echo "3. API health check..."
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/flags)
if [ "$HTTP_CODE" = "200" ]; then
  echo "   ✅ API responding (200)"
else
  echo "   ❌ API returned $HTTP_CODE"
  exit 1
fi

# 4. Create guest session
echo "4. Creating guest session..."
GUEST=$(curl -s -X POST http://localhost:3001/api/guest-sessions \
  -H 'Content-Type: application/json' \
  -d '{"nickname":"ScriptTest"}')
TOKEN=$(echo "$GUEST" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
PLAYER_ID=$(echo "$GUEST" | grep -o '"playerId":"[^"]*"' | cut -d'"' -f4)
if [ -n "$TOKEN" ]; then
  echo "   ✅ Guest created: $PLAYER_ID"
else
  echo "   ❌ Failed: $GUEST"
  exit 1
fi

# 5. Create room
echo "5. Creating room..."
ROOM=$(curl -s -X POST http://localhost:3001/api/rooms \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"mode":"CLASSIC","rounds":1,"turnDuration":60,"maxPlayers":8}}')
ROOM_CODE=$(echo "$ROOM" | grep -o '"roomCode":"[^"]*"' | cut -d'"' -f4)
ROOM_ID=$(echo "$ROOM" | grep -o '"roomId":"[^"]*"' | cut -d'"' -f4)
if [ -n "$ROOM_CODE" ]; then
  echo "   ✅ Room created: $ROOM_CODE"
else
  echo "   ❌ Failed: $ROOM"
  exit 1
fi

# 6. Check DB for recent guesses
echo "6. Checking DB for recent guesses..."
GUESS_COUNT=$(PGPASSWORD=drawbattle psql -h localhost -p 5440 -U drawbattle -d drawbattle -t -c \
  "SELECT COUNT(*) FROM guesses WHERE received_at > NOW() - INTERVAL '1 hour';" 2>/dev/null | tr -d ' ')
echo "   Guesses in last hour: $GUESS_COUNT"

# 7. Check DB for recent scores > 0
echo "7. Checking for scores > 0..."
HIGH_SCORES=$(PGPASSWORD=drawbattle psql -h localhost -p 5440 -U drawbattle -d drawbattle -t -c \
  "SELECT COUNT(*) FROM scores WHERE points > 0 AND updated_at > NOW() - INTERVAL '1 hour';" 2>/dev/null | tr -d ' ')
echo "   Scores > 0 in last hour: $HIGH_SCORES"

# 8. Check matches
echo "8. Checking recent matches..."
MATCH_COUNT=$(PGPASSWORD=drawbattle psql -h localhost -p 5440 -U drawbattle -d drawbattle -t -c \
  "SELECT COUNT(*) FROM matches WHERE ended_at > NOW() - INTERVAL '1 hour';" 2>/dev/null | tr -d ' ')
echo "   Matches ended in last hour: $MATCH_COUNT"

# 9. Run Playwright scoring test
echo "9. Running Playwright scoring test..."
cd apps/web
npx playwright test e2e/scoring-smoke.spec.ts --reporter=line 2>&1 | tail -5

echo ""
echo "=== Summary ==="
echo "  Room created: $ROOM_CODE"
echo "  Guesses (1h): $GUESS_COUNT"
echo "  Scores > 0 (1h): $HIGH_SCORES"
echo "  Matches (1h): $MATCH_COUNT"
echo ""
echo "To fully test scoring, run: npx playwright test e2e/scoring-fix.spec.ts"
