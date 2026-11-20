-- AlterTable: soft-delete marker for players who left the room.
-- Keeps guess/score FK history intact while freeing the room slot.
ALTER TABLE "room_players" ADD COLUMN "left_at" TIMESTAMP(3);

-- Every join/active-player query filters on (room_id, left_at).
CREATE INDEX "room_players_room_id_left_at_idx" ON "room_players"("room_id", "left_at");
