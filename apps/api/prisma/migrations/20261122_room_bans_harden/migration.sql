-- Follow-up to 20261120_room_bans and 20261120_room_player_left_at.
-- Keeps already-applied migration checksums untouched while aligning the live
-- schema with the current Prisma schema.

-- Query pattern for active-room players filters on both columns.
CREATE INDEX IF NOT EXISTS "room_players_room_id_left_at_idx"
    ON "room_players"("room_id", "left_at");

-- Let PostgreSQL generate ban ids for direct SQL inserts as well as Prisma.
ALTER TABLE "room_bans"
    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- Full compound uniques match Prisma's @@unique clauses and are valid
-- ON CONFLICT arbiters for upsert. PostgreSQL still treats NULLs as distinct,
-- so multiple rows without a given identity do not collide.
DROP INDEX IF EXISTS "room_bans_room_id_user_id_key";
CREATE UNIQUE INDEX "room_bans_room_id_user_id_key"
    ON "room_bans"("room_id", "user_id");

DROP INDEX IF EXISTS "room_bans_room_id_guest_session_id_key";
CREATE UNIQUE INDEX "room_bans_room_id_guest_session_id_key"
    ON "room_bans"("room_id", "guest_session_id");
