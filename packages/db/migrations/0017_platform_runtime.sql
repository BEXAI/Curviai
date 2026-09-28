-- Batch 2 platform (docs/phases/PHASE_11.md, b2/platform).
-- recipes.fallback_models: models the worker tries in order after
--   recipes.model fails, routed through @curvi/ai failover, so a model swap
--   is a row update instead of a deploy. Several active versions of one key
--   are an A/B test weighted by traffic_pct.
-- generation_jobs.recipe_variants: which recipe version each stage of the
--   job ran on, keyed by recipe key.
-- generation_jobs (status, updated_at): the scheduled stale job sweep
--   (/api/cron/stale-jobs) reads live jobs by status and age across every
--   workspace.
ALTER TABLE "generation_jobs" ADD COLUMN "recipe_variants" jsonb;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "fallback_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "generation_jobs_status_updated_at_idx" ON "generation_jobs" USING btree ("status","updated_at");
