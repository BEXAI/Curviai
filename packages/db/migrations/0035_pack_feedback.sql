CREATE TABLE "pack_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"usable" text NOT NULL,
	"would_pay" text,
	"comment" text,
	"quote_consent" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_feedback_usable_check" CHECK ("pack_feedback"."usable" in ('yes', 'some', 'not_yet')),
	CONSTRAINT "pack_feedback_would_pay_check" CHECK ("pack_feedback"."would_pay" is null or "pack_feedback"."would_pay" in ('yes', 'maybe', 'no')),
	CONSTRAINT "pack_feedback_lengths_check" CHECK (char_length(coalesce("pack_feedback"."comment", '')) <= 500 and char_length(coalesce("pack_feedback"."display_name", '')) <= 60),
	CONSTRAINT "pack_feedback_quote_check" CHECK (not "pack_feedback"."quote_consent" or char_length(btrim(coalesce("pack_feedback"."comment", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "pack_feedback" ADD CONSTRAINT "pack_feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_feedback" ADD CONSTRAINT "pack_feedback_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_feedback_job_user_uq" ON "pack_feedback" USING btree ("job_id","user_id");--> statement-breakpoint
CREATE INDEX "pack_feedback_workspace_id_idx" ON "pack_feedback" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pack_feedback_created_at_idx" ON "pack_feedback" USING btree ("created_at");--> statement-breakpoint

-- >>> Phase 18 hand written: pack_feedback
--
-- docs/phases/PHASE_18.md P18-05 (Lane 6 Concierge).
--
-- pack_feedback is a tenant table. Members of the workspace read their
-- workspace's answers. The server writes each answer over the owner
-- connection after it checks that the person is a member and the pack is
-- finished, so there is no insert, update or delete policy, and the client
-- roles lose their write grants as a second layer (the 0026 pattern).

ALTER TABLE "pack_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['pack_feedback'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;--> statement-breakpoint

CREATE POLICY "pack_feedback_select_member" ON "pack_feedback"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.pack_feedback FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
-- <<< Phase 18 hand written: pack_feedback
