-- Durable render queue and funnel event log.
-- Replaces the in-memory fallbacks used before this migration while keeping
-- existing tables/checksums untouched.

CREATE TYPE "RenderJobState" AS ENUM ('queued', 'running', 'completed', 'failed');

CREATE TABLE "render_jobs" (
    "id" TEXT NOT NULL,
    "replay_id" TEXT NOT NULL,
    "state" "RenderJobState" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT,
    "locked_by" TEXT,
    "locked_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "render_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "render_jobs_replay_id_key" ON "render_jobs"("replay_id");
CREATE INDEX "render_jobs_state_next_attempt_at_idx" ON "render_jobs"("state", "next_attempt_at");

ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_replay_id_fkey"
    FOREIGN KEY ("replay_id") REFERENCES "replays"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "funnel_events" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "funnel_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "funnel_events_created_at_idx" ON "funnel_events"("created_at");
CREATE INDEX "funnel_events_event_created_at_idx" ON "funnel_events"("event", "created_at");
