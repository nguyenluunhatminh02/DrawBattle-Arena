#!/usr/bin/env bash
set -euo pipefail

echo "=== Testing migration on clean database ==="

# Stop existing postgres if running
docker stop drawbattle-test-db 2>/dev/null || true
docker rm drawbattle-test-db 2>/dev/null || true

# Start fresh postgres
echo "Starting fresh PostgreSQL..."
docker run -d --name drawbattle-test-db \
  -e POSTGRES_USER=drawbattle \
  -e POSTGRES_PASSWORD=drawbattle \
  -e POSTGRES_DB=drawbattle \
  -p 5441:5432 \
  postgres:16-alpine

# Wait for postgres to be ready
echo "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
  if docker exec drawbattle-test-db pg_isready -U drawbattle >/dev/null 2>&1; then
    echo "PostgreSQL is ready!"
    break
  fi
  sleep 1
done

# Run migrations
echo "Running migrations..."
cd apps/api
DATABASE_URL="postgresql://drawbattle:drawbattle@localhost:5441/drawbattle?schema=public" \
  pnpm exec prisma migrate deploy

# Verify tables exist
echo "Verifying tables..."
TABLE_COUNT=$(docker exec drawbattle-test-db psql -U drawbattle -d drawbattle -t -c "
  SELECT COUNT(*) FROM information_schema.tables 
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
" | tr -d ' ')

echo "Tables created: $TABLE_COUNT"

if [ "$TABLE_COUNT" -lt 15 ]; then
  echo "ERROR: Expected at least 15 tables, got $TABLE_COUNT"
  docker stop drawbattle-test-db
  docker rm drawbattle-test-db
  exit 1
fi

# Cleanup
echo "Cleaning up..."
docker stop drawbattle-test-db
docker rm drawbattle-test-db

echo "=== Migration test PASSED ==="
