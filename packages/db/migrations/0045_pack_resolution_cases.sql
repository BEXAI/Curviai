CREATE TABLE "pack_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_kind" text NOT NULL,
	"status" text,
	"message" text NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_case_events_actor_check" CHECK ("pack_case_events"."actor_kind" IN ('seller','operator','system')),
	CONSTRAINT "pack_case_events_status_check" CHECK ("pack_case_events"."status" IS NULL OR "pack_case_events"."status" IN ('received','reviewing','awaiting_seller','resolved')),
	CONSTRAINT "pack_case_events_message_length" CHECK (char_length(btrim("pack_case_events"."message")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "pack_case_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_case_notes_message_length" CHECK (char_length(btrim("pack_case_notes"."message")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "pack_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"description" text NOT NULL,
	"shot_id" text,
	"version_id" uuid,
	"feedback_id" uuid,
	"source_support_request_id" uuid,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "pack_cases_category_check" CHECK ("pack_cases"."category" IN ('fidelity','compliance','missing_output','credits','other')),
	CONSTRAINT "pack_cases_status_check" CHECK ("pack_cases"."status" IN ('received','reviewing','awaiting_seller','resolved')),
	CONSTRAINT "pack_cases_description_length" CHECK (char_length(btrim("pack_cases"."description")) BETWEEN 10 AND 2000),
	CONSTRAINT "pack_cases_shot_length" CHECK ("pack_cases"."shot_id" IS NULL OR char_length("pack_cases"."shot_id") BETWEEN 1 AND 160),
	CONSTRAINT "pack_cases_resolution_check" CHECK (("pack_cases"."status" = 'resolved') = ("pack_cases"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "pack_case_events" ADD CONSTRAINT "pack_case_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_case_events" ADD CONSTRAINT "pack_case_events_case_id_pack_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pack_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_case_notes" ADD CONSTRAINT "pack_case_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_case_notes" ADD CONSTRAINT "pack_case_notes_case_id_pack_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pack_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cases" ADD CONSTRAINT "pack_cases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cases" ADD CONSTRAINT "pack_cases_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cases" ADD CONSTRAINT "pack_cases_version_id_asset_variants_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."asset_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cases" ADD CONSTRAINT "pack_cases_feedback_id_pack_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."pack_feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_case_events_request_uq" ON "pack_case_events" USING btree ("case_id","request_id");--> statement-breakpoint
CREATE INDEX "pack_case_events_workspace_case_idx" ON "pack_case_events" USING btree ("workspace_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "pack_case_notes_workspace_case_idx" ON "pack_case_notes" USING btree ("workspace_id","case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_cases_request_uq" ON "pack_cases" USING btree ("workspace_id","reporter_user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_cases_open_category_uq" ON "pack_cases" USING btree ("workspace_id","job_id","category") WHERE "pack_cases"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "pack_cases_workspace_updated_idx" ON "pack_cases" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "pack_cases_resolved_at_idx" ON "pack_cases" USING btree ("resolved_at");
--> statement-breakpoint
-- Phase 21 case references never retain photo bytes. Workspace/job deletion
-- cascades the complete case; asset/feedback removal clears only its reference.
-- The application purges resolved cases after 180 days and exports public
-- cases/events only. Operator notes follow case deletion, never customer export.
CREATE FUNCTION enforce_pack_case_parent() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.shot_id IS DISTINCT FROM OLD.shot_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.source_support_request_id IS DISTINCT FROM OLD.source_support_request_id
    OR NEW.description IS DISTINCT FROM OLD.description
    OR (NEW.version_id IS DISTINCT FROM OLD.version_id AND (NEW.version_id IS NOT NULL OR EXISTS (SELECT 1 FROM asset_variants WHERE id = OLD.version_id)))
    OR (NEW.feedback_id IS DISTINCT FROM OLD.feedback_id AND (NEW.feedback_id IS NOT NULL OR EXISTS (SELECT 1 FROM pack_feedback WHERE id = OLD.feedback_id)))
  ) THEN RAISE EXCEPTION 'pack case references are immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM generation_jobs WHERE id = NEW.job_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'pack case job must belong to workspace';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.reporter_user_id) THEN
    RAISE EXCEPTION 'pack case reporter must belong to workspace';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.shot_id IS NOT NULL AND NOT (
    EXISTS (SELECT 1 FROM job_steps WHERE workspace_id = NEW.workspace_id AND job_id = NEW.job_id AND shot_id = NEW.shot_id)
    OR EXISTS (SELECT 1 FROM assets WHERE workspace_id = NEW.workspace_id AND job_id = NEW.job_id AND qc->>'shotId' = NEW.shot_id)
  ) THEN RAISE EXCEPTION 'pack case shot must belong to job'; END IF;
  IF NEW.version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM asset_variants v JOIN assets a ON a.id = v.asset_id
    WHERE v.id = NEW.version_id AND v.workspace_id = NEW.workspace_id AND a.workspace_id = NEW.workspace_id
      AND a.job_id = NEW.job_id AND (NEW.shot_id IS NULL OR a.qc->>'shotId' = NEW.shot_id)
  ) THEN RAISE EXCEPTION 'pack case version must belong to job and shot'; END IF;
  IF NEW.feedback_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pack_feedback WHERE id = NEW.feedback_id AND workspace_id = NEW.workspace_id
      AND job_id = NEW.job_id AND user_id = NEW.reporter_user_id
  ) THEN RAISE EXCEPTION 'pack case feedback must belong to reporter and job'; END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER pack_cases_parent BEFORE INSERT OR UPDATE ON pack_cases FOR EACH ROW EXECUTE FUNCTION enforce_pack_case_parent();
--> statement-breakpoint
CREATE FUNCTION enforce_pack_case_child() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'pack case history is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pack_cases WHERE id = NEW.case_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'pack case history must belong to workspace';
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER pack_case_events_parent BEFORE INSERT OR UPDATE ON pack_case_events FOR EACH ROW EXECUTE FUNCTION enforce_pack_case_child();
--> statement-breakpoint
CREATE TRIGGER pack_case_notes_parent BEFORE INSERT OR UPDATE ON pack_case_notes FOR EACH ROW EXECUTE FUNCTION enforce_pack_case_child();
--> statement-breakpoint
ALTER TABLE pack_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_case_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pack_cases_select_reporter_manager ON pack_cases FOR SELECT USING (
  EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = pack_cases.workspace_id AND m.user_id = auth.uid()
    AND (m.user_id = pack_cases.reporter_user_id OR m.role IN ('owner','admin')))
);
CREATE POLICY pack_case_events_select_visible_case ON pack_case_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM pack_cases c WHERE c.id = pack_case_events.case_id AND c.workspace_id = pack_case_events.workspace_id)
);
--> statement-breakpoint
DO $do$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['pack_cases','pack_case_events','pack_case_notes'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',t,'client_id','client_id');
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',t,r); END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role',t); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN GRANT SELECT ON pack_cases, pack_case_events TO authenticated; END IF;
END $do$;
