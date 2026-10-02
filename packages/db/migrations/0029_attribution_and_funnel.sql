CREATE TABLE "signup_attributions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"self_reported" text,
	"self_reported_other" text,
	"source" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"ref" text,
	"share_slug" text,
	"claim_id" text,
	"preview_id" text,
	"landing_path" text,
	"referrer_host" text,
	"first_seen_at" timestamp with time zone,
	"consent" text,
	"method" text DEFAULT 'email' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_attributions_consent_check" CHECK ("signup_attributions"."consent" is null or "signup_attributions"."consent" in ('granted', 'denied')),
	CONSTRAINT "signup_attributions_method_check" CHECK ("signup_attributions"."method" in ('email', 'google')),
	CONSTRAINT "signup_attributions_lengths_check" CHECK (char_length(coalesce("signup_attributions"."self_reported", '')) <= 40
        and char_length(coalesce("signup_attributions"."self_reported_other", '')) <= 80
        and char_length(coalesce("signup_attributions"."source", '')) <= 40
        and char_length(coalesce("signup_attributions"."utm_source", '')) <= 100
        and char_length(coalesce("signup_attributions"."utm_medium", '')) <= 100
        and char_length(coalesce("signup_attributions"."utm_campaign", '')) <= 100
        and char_length(coalesce("signup_attributions"."utm_content", '')) <= 100
        and char_length(coalesce("signup_attributions"."utm_term", '')) <= 100
        and char_length(coalesce("signup_attributions"."ref", '')) <= 32
        and char_length(coalesce("signup_attributions"."share_slug", '')) <= 32
        and char_length(coalesce("signup_attributions"."claim_id", '')) <= 64
        and char_length(coalesce("signup_attributions"."preview_id", '')) <= 36
        and char_length(coalesce("signup_attributions"."landing_path", '')) <= 200
        and char_length(coalesce("signup_attributions"."referrer_host", '')) <= 100)
);
--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD CONSTRAINT "signup_attributions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signup_attributions_workspace_id_idx" ON "signup_attributions" USING btree ("workspace_id");--> statement-breakpoint

-- >>> Phase 18 hand written: attribution_and_funnel
--
-- docs/phases/PHASE_18.md P18-01 and P18-02 (Lane 1 Measure).
--
-- signup_attributions is a tenant table. Owners and admins of the workspace
-- read their own row; the auth callback writes it once per user over the
-- owner connection, so there is no insert, update or delete policy and the
-- client roles lose their write grants as a second layer (the 0026 pattern).
--
-- events_funnel_first_uq makes each funnel.first_<step> row once per
-- workspace under concurrency (the 0003 events_billing_dedupe_uq pattern):
-- recordFunnelEvent inserts it with ON CONFLICT DO NOTHING.
--
-- events_insert_member (0002) let any member insert an event of any name
-- into their own workspace. The server side funnel (funnel.%) and the
-- billing dedupe claims (billing:%) are written only by the owner
-- connection, so a member could otherwise forge funnel steps in the
-- founder's weekly numbers, take a workspace's funnel.first_<step> slot
-- first, or claim a billing dedupe name before the webhook does. The
-- operator events (ops:%, P18-04's ops:prospect_credits, which the monthly
-- prospect credit cap sums) are server only too: a member of the operator's
-- workspace could otherwise lift the cap with a negative row or break it
-- with a value that is not a number. The policy is recreated with all three
-- prefixes refused; client analytics names keep working as before.

ALTER TABLE "signup_attributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['signup_attributions'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;--> statement-breakpoint

CREATE POLICY "signup_attributions_select_owner_admin" ON "signup_attributions"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')));--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.signup_attributions FROM %I', r);
    END IF;
  END LOOP;
END
$do$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "events_funnel_first_uq"
  ON "events" ("workspace_id", "name")
  WHERE "name" LIKE 'funnel.first_%';--> statement-breakpoint

DROP POLICY IF EXISTS "events_insert_member" ON "events";--> statement-breakpoint

CREATE POLICY "events_insert_member" ON "events"
  FOR INSERT
  WITH CHECK (
    workspace_id in (select workspace_id from members where user_id = auth.uid())
    and name not like 'funnel.%'
    and name not like 'billing:%'
    and name not like 'ops:%'
  );
-- <<< Phase 18 hand written: attribution_and_funnel