ALTER TABLE "generation_jobs" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_request_fingerprint_format" CHECK ("generation_jobs"."request_fingerprint" IS NULL OR "generation_jobs"."request_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- Existing member job-write policies do not authorize forging or removing
-- the server's accepted-request receipt. This protection matches the
-- restart and runner-column guards in 0030 and 0041.
CREATE FUNCTION enforce_generation_job_request_fingerprint() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.request_fingerprint IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolname = 'service_role')
    ) THEN
      RAISE EXCEPTION 'generation_jobs request_fingerprint can only be changed by the server';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER generation_jobs_protect_request_fingerprint
BEFORE INSERT OR UPDATE ON "generation_jobs"
FOR EACH ROW EXECUTE FUNCTION enforce_generation_job_request_fingerprint();
