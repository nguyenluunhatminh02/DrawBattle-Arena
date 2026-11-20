-- AlterTable: soft-delete marker for players who left the room.
-- Keeps guess/score FK history intact while freeing the room slot.
ALTER TABLE "room_players" ADD COLUMN "left_at" TIMESTAMP(3);
