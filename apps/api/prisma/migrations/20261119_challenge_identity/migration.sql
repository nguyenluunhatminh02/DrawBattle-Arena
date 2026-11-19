-- AlterTable: add creatorSessionId to challenges
ALTER TABLE "challenges" ADD COLUMN "creator_session_id" TEXT;

-- AlterTable: add solverSessionId to challenge_attempts
ALTER TABLE "challenge_attempts" ADD COLUMN "solver_session_id" TEXT;
