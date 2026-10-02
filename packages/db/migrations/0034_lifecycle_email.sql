CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_key" text NOT NULL,
	"workspace_id" uuid,
	"template" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_sends_kind_check" CHECK ("email_sends"."kind" in ('transactional', 'marketing')),
	CONSTRAINT "email_sends_status_check" CHECK ("email_sends"."status" in ('pending', 'sent', 'failed', 'suppressed', 'disabled')),
	CONSTRAINT "email_sends_recipient_key_check" CHECK ("email_sends"."recipient_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_sends_lengths_check" CHECK (char_length("email_sends"."template") between 1 and 40
        and char_length("email_sends"."dedupe_key") between 1 and 200
        and char_length(coalesce("email_sends"."provider_id", '')) <= 100
        and char_length(coalesce("email_sends"."error", '')) <= 500
        and "email_sends"."attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"recipient_key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_scope_check" CHECK ("email_suppressions"."scope" in ('marketing', 'all')),
	CONSTRAINT "email_suppressions_reason_check" CHECK ("email_suppressions"."reason" in ('unsubscribed', 'bounced', 'complained', 'manual')),
	CONSTRAINT "email_suppressions_recipient_key_check" CHECK ("email_suppressions"."recipient_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "marketing_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "consent_source" text;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_dedupe_key_uq" ON "email_sends" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_sends_recipient_key_idx" ON "email_sends" USING btree ("recipient_key");--> statement-breakpoint
CREATE INDEX "email_sends_workspace_id_idx" ON "email_sends" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "email_sends_updated_at_idx" ON "email_sends" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_consent_check" CHECK (("leads"."marketing_consent_at" is null) = ("leads"."consent_source" is null) and char_length(coalesce("leads"."consent_source", '')) <= 40);
-- >>> Phase 18 hand written: lifecycle_email
--> statement-breakpoint
-- lifecycle_email (docs/phases/PHASE_18.md P18-06). email_sends logs every
-- lifecycle email attempt, one row per dedupe key; email_suppressions holds
-- the addresses Curvi must not email (a marketing unsubscribe, or all mail
-- after a hard bounce or a spam complaint). Both log mail to leads, who
-- have no workspace, so they are platform tables like leads (0016) and
-- free_previews: RLS on with no policies, and anon and authenticated lose
-- every privilege, so only the owner connection (the web app) and the
-- service role read or write them. No address is stored: recipient_key is
-- the sha256 of the email normalized by normalized_email_key (0012).
-- leads keeps its RLS and revoked privileges (0016); its two new columns
-- record the marketing consent box (founder decision 5).
ALTER TABLE "email_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['email_sends', 'email_suppressions'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.email_sends FROM %I', r);
      EXECUTE format('REVOKE ALL ON TABLE public.email_suppressions FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
-- <<< Phase 18 hand written: lifecycle_email
