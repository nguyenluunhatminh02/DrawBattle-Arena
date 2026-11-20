-- Every join/active-player query filters on (room_id, left_at).
CREATE INDEX "room_players_room_id_left_at_idx" ON "room_players"("room_id", "left_at");
