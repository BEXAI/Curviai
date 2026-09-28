-- Runner integrity (fix/runner-integrity).
--
-- generation_jobs.run_key names the run that owns the job right now. The web
-- app sets a fresh key in the same transaction that queues a first run or a
-- pack follow up, and every liveness check of the runner (heartbeat, state
-- writes, the pack and follow up delivery checks, ledger writes) requires it,
-- so a stale runner of an earlier run is refused even after a follow up moved
-- the job from done back to generating. A cancel or a settle changes it.
-- Existing rows keep a null key and are checked by status alone, so jobs
-- already queued at deploy time still finish.
--
-- Idempotency keys become unique per workspace instead of globally, so two
-- workspaces sending the same key never collide and a conflict never reveals
-- that another workspace used it. The old constraint was global, so no
-- existing rows can violate the composite index.
--
-- subscriptions.cancel_at_period_end records a subscription set to end at
-- period_end instead of renewing. Column only; existing rows read false.
ALTER TABLE "generation_jobs" DROP CONSTRAINT IF EXISTS "generation_jobs_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "run_key" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_workspace_idempotency_key_uq" ON "generation_jobs" USING btree ("workspace_id","idempotency_key");
