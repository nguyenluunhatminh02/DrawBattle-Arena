-- Baseline migration: full schema initialization
-- CreateTable: enums
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "RoomVisibility" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');
CREATE TYPE "RoomStatus" AS ENUM ('WAITING', 'PLAYING', 'FINISHED');
CREATE TYPE "PlayerRole" AS ENUM ('HOST', 'PLAYER', 'SPECTATOR');
CREATE TYPE "MatchStatus" AS ENUM ('IN_PROGRESS', 'FINISHED', 'CANCELLED');
CREATE TYPE "TurnStatus" AS ENUM ('WORD_PICK', 'DRAWING', 'REVEAL', 'NEXT_TURN', 'FINISHED');
CREATE TYPE "WordDifficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');
CREATE TYPE "ChallengeStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DELETED');

-- CreateTable: users
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "avatar" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateTable: guest_sessions
CREATE TABLE "guest_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guest_sessions_token_hash_key" ON "guest_sessions"("token_hash");
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: rooms
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "host_player_id" TEXT,
    "visibility" "RoomVisibility" NOT NULL DEFAULT 'PRIVATE',
    "settings" JSONB NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'WAITING',
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateTable: room_players
CREATE TABLE "room_players" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "user_id" TEXT,
    "guest_session_id" TEXT,
    "nickname_snapshot" TEXT NOT NULL,
    "role" "PlayerRole" NOT NULL DEFAULT 'PLAYER',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "room_players_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "room_players_room_id_user_id_key" ON "room_players"("room_id", "user_id");
CREATE UNIQUE INDEX "room_players_room_id_guest_session_id_key" ON "room_players"("room_id", "guest_session_id");
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_guest_session_id_fkey" FOREIGN KEY ("guest_session_id") REFERENCES "guest_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: categories
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateTable: words
CREATE TABLE "words" (
    "id" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "difficulty" "WordDifficulty" NOT NULL,
    "synonyms" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "words_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "words_canonical_key" ON "words"("canonical");
CREATE INDEX "words_category_id_difficulty_active_idx" ON "words"("category_id", "difficulty", "active");
ALTER TABLE "words" ADD CONSTRAINT "words_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: matches
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "rules" JSONB NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "matches" ADD CONSTRAINT "matches_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: rounds
CREATE TABLE "rounds" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "cycle_no" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    CONSTRAINT "rounds_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: turns
CREATE TABLE "turns" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "drawer_id" TEXT NOT NULL,
    "word_id" TEXT NOT NULL,
    "status" "TurnStatus" NOT NULL DEFAULT 'WORD_PICK',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    CONSTRAINT "turns_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "turns" ADD CONSTRAINT "turns_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "turns" ADD CONSTRAINT "turns_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "words"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: guesses
CREATE TABLE "guesses" (
    "id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "guess_text" TEXT NOT NULL,
    "normalized_text" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guesses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "guesses_turn_id_received_at_idx" ON "guesses"("turn_id", "received_at");
CREATE INDEX "guesses_turn_id_player_id_idx" ON "guesses"("turn_id", "player_id");
ALTER TABLE "guesses" ADD CONSTRAINT "guesses_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guesses" ADD CONSTRAINT "guesses_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "room_players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: scores
CREATE TABLE "scores" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "scores_match_id_player_id_key" ON "scores"("match_id", "player_id");
ALTER TABLE "scores" ADD CONSTRAINT "scores_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scores" ADD CONSTRAINT "scores_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "room_players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: replays
CREATE TABLE "replays" (
    "id" TEXT NOT NULL,
    "turn_id" TEXT,
    "challenge_id" TEXT,
    "daily_id" TEXT,
    "strokes" JSONB NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "gif_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "replays_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "replays_turn_id_key" ON "replays"("turn_id");
CREATE UNIQUE INDEX "replays_challenge_id_key" ON "replays"("challenge_id");
CREATE UNIQUE INDEX "replays_daily_id_key" ON "replays"("daily_id");
ALTER TABLE "replays" ADD CONSTRAINT "replays_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: challenges (with creatorSessionId)
CREATE TABLE "challenges" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT,
    "creator_session_id" TEXT,
    "word_id" TEXT NOT NULL,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "replay_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "challenges_status_expires_at_idx" ON "challenges"("status", "expires_at");
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "words"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_replay_id_fkey" FOREIGN KEY ("replay_id") REFERENCES "replays"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: challenge_attempts (with solverSessionId)
CREATE TABLE "challenge_attempts" (
    "id" TEXT NOT NULL,
    "challenge_id" TEXT NOT NULL,
    "solver_id" TEXT,
    "solver_session_id" TEXT,
    "attempt_no" INTEGER NOT NULL,
    "answer" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "challenge_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "challenge_attempts_challenge_id_attempt_no_idx" ON "challenge_attempts"("challenge_id", "attempt_no");
ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_solver_id_fkey" FOREIGN KEY ("solver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: reports
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at");

-- CreateTable: daily_challenges
CREATE TABLE "daily_challenges" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "word_id" TEXT NOT NULL,
    "creator_id" TEXT,
    "replay_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "daily_challenges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "daily_challenges_date_key" ON "daily_challenges"("date");
CREATE INDEX "daily_challenges_date_idx" ON "daily_challenges"("date");
ALTER TABLE "daily_challenges" ADD CONSTRAINT "daily_challenges_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "words"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_challenges" ADD CONSTRAINT "daily_challenges_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: daily_challenge_attempts
CREATE TABLE "daily_challenge_attempts" (
    "id" TEXT NOT NULL,
    "daily_challenge_id" TEXT NOT NULL,
    "user_id" TEXT,
    "guest_session_id" TEXT,
    "answer" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "correct" BOOLEAN NOT NULL DEFAULT false,
    "time_to_guess_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "daily_challenge_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "daily_challenge_attempts_daily_challenge_id_user_id_idx" ON "daily_challenge_attempts"("daily_challenge_id", "user_id");
CREATE INDEX "daily_challenge_attempts_daily_challenge_id_guest_session_id_idx" ON "daily_challenge_attempts"("daily_challenge_id", "guest_session_id");
ALTER TABLE "daily_challenge_attempts" ADD CONSTRAINT "daily_challenge_attempts_daily_challenge_id_fkey" FOREIGN KEY ("daily_challenge_id") REFERENCES "daily_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_challenge_attempts" ADD CONSTRAINT "daily_challenge_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "daily_challenge_attempts" ADD CONSTRAINT "daily_challenge_attempts_guest_session_id_fkey" FOREIGN KEY ("guest_session_id") REFERENCES "guest_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: streaks
CREATE TABLE "streaks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "longest_streak" INTEGER NOT NULL DEFAULT 0,
    "last_played_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "streaks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "streaks_user_id_key" ON "streaks"("user_id");
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: leaderboard_snapshots
CREATE TABLE "leaderboard_snapshots" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "leaderboard_snapshots_period_rank_idx" ON "leaderboard_snapshots"("period", "rank");
CREATE INDEX "leaderboard_snapshots_period_user_id_idx" ON "leaderboard_snapshots"("period", "user_id");

-- CreateTable: feature_flags
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "variant" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "feature_flags_name_key" ON "feature_flags"("name");

-- CreateTable: moderation_actions
CREATE TABLE "moderation_actions" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "moderation_actions_target_type_target_id_idx" ON "moderation_actions"("target_type", "target_id");
CREATE INDEX "moderation_actions_created_at_idx" ON "moderation_actions"("created_at");

-- Replay FKs (deferred until tables exist)
ALTER TABLE "replays" ADD CONSTRAINT "replays_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "replays" ADD CONSTRAINT "replays_daily_id_fkey" FOREIGN KEY ("daily_id") REFERENCES "daily_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
