ALTER TABLE "generation_jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "generation_jobs_live_heartbeat_idx" ON "generation_jobs" USING btree ("status","heartbeat_at") WHERE "generation_jobs"."status" IN ('queued', 'analyzing', 'planning', 'generating', 'qc', 'packaging');--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_runner_id_length" CHECK ("generation_jobs"."runner_id" IS NULL OR char_length("generation_jobs"."runner_id") <= 64);--> statement-breakpoint

-- >>> Phase 20 hand written: runner_columns
-- generation_jobs still allows member updates (0001). The recovery lease
-- must only be written by the server, just like the restart input (0030).
CREATE FUNCTION enforce_generation_job_runner_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (TG_OP = 'INSERT' AND (
        NEW.heartbeat_at IS NOT NULL OR NEW.runner_id IS NOT NULL
        OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (
        NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
        OR NEW.runner_id IS DISTINCT FROM OLD.runner_id
        OR NEW.started_at IS DISTINCT FROM OLD.started_at
        OR NEW.finished_at IS DISTINCT FROM OLD.finished_at)) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolname = 'service_role')
    ) THEN
      RAISE EXCEPTION 'generation_jobs runner metadata can only be changed by the server';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER generation_jobs_protect_runner_columns
BEFORE INSERT OR UPDATE ON "generation_jobs"
FOR EACH ROW EXECUTE FUNCTION enforce_generation_job_runner_columns();
-- <<< Phase 20 hand written: runner_columns
