ALTER TABLE "generation_jobs" ADD COLUMN "restart_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "restart_payload" jsonb;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_restart_payload_object" CHECK ("generation_jobs"."restart_payload" IS NULL OR jsonb_typeof("generation_jobs"."restart_payload") = 'object');--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_restart_count_range" CHECK ("generation_jobs"."restart_count" >= 0);--> statement-breakpoint
-- >>> Phase 18 hand written: deploy_restarts
-- Deploy restarts (docs/phases/PHASE_18.md P18-23). A deploy that stops a
-- pack queues it to start again: the old instance writes a run key
-- prefixed restart:, bumps restart_count and saves the worker payload in
-- restart_payload; a running instance claims the job and runs that
-- payload. The pickup trusts those three, so only the server may set them.
-- Members keep their existing read and update policies on generation_jobs
-- (0001), so a trigger refuses any client connection that changes
-- restart_count or restart_payload, or moves run_key to a restart: key
-- (insert or update). A trigger rather than column grants, for the reason
-- 0002 gives for the workspaces billing columns: it holds the same way on
-- Supabase and in the PGlite harness. Server connections (superuser,
-- BYPASSRLS roles such as Supabase's postgres and service_role) pass.
CREATE FUNCTION enforce_generation_job_restart_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (TG_OP = 'INSERT' AND (
        NEW.restart_count <> 0
        OR NEW.restart_payload IS NOT NULL
        OR starts_with(coalesce(NEW.run_key, ''), 'restart:')))
     OR (TG_OP = 'UPDATE' AND (
        NEW.restart_count IS DISTINCT FROM OLD.restart_count
        OR NEW.restart_payload IS DISTINCT FROM OLD.restart_payload
        OR (NEW.run_key IS DISTINCT FROM OLD.run_key AND starts_with(coalesce(NEW.run_key, ''), 'restart:')))) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolname = 'service_role')
    ) THEN
      RAISE EXCEPTION 'generation_jobs restart_count, restart_payload and restart run keys can only be changed by the server';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER generation_jobs_protect_restart_columns
BEFORE INSERT OR UPDATE ON "generation_jobs"
FOR EACH ROW
EXECUTE FUNCTION enforce_generation_job_restart_columns();
-- <<< Phase 18 hand written: deploy_restarts
