-- Durable per-room kick bans. DB is authoritative: bans survive restarts and
-- cannot be bypassed by changing sockets, sessions or node processes.
CREATE TABLE "room_bans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id" TEXT NOT NULL,
    "user_id" TEXT,
    "guest_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "room_bans_pkey" PRIMARY KEY ("id")
);

-- Full compound uniques match Prisma's @@unique clauses and are valid
-- ON CONFLICT arbiters for `upsert`. PostgreSQL treats NULLs as distinct,
-- so rows with a NULL identity still do not collide with each other.
CREATE UNIQUE INDEX "room_bans_room_id_user_id_key"
    ON "room_bans"("room_id", "user_id");
CREATE UNIQUE INDEX "room_bans_room_id_guest_session_id_key"
    ON "room_bans"("room_id", "guest_session_id");
CREATE INDEX "room_bans_room_id_created_at_idx"
    ON "room_bans"("room_id", "created_at");

ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Identity rows are kept as audit history; deleting one clears its ban identity
-- rather than cascading a ban away.
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_guest_session_id_fkey"
    FOREIGN KEY ("guest_session_id") REFERENCES "guest_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
