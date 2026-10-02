CREATE TABLE "free_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"blocked_reason" text,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"source_format" text,
	"main_format" text,
	"email_key" text,
	"claimed_workspace_id" uuid,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "free_previews_status_check" CHECK ("free_previews"."status" in ('running', 'done', 'blocked', 'failed', 'claimed')),
	CONSTRAINT "free_previews_ip_hash_check" CHECK ("free_previews"."ip_hash" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "free_previews_email_key_check" CHECK ("free_previews"."email_key" is null or "free_previews"."email_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "free_previews_source_format_check" CHECK ("free_previews"."source_format" is null or "free_previews"."source_format" in ('jpeg', 'png', 'webp')),
	CONSTRAINT "free_previews_main_format_check" CHECK ("free_previews"."main_format" is null or "free_previews"."main_format" in ('jpeg', 'png')),
	CONSTRAINT "free_previews_lengths_check" CHECK (char_length(coalesce("free_previews"."blocked_reason", '')) <= 200 and "free_previews"."cost_micros" >= 0),
	CONSTRAINT "free_previews_claim_check" CHECK (("free_previews"."status" = 'claimed') = ("free_previews"."claimed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "free_previews" ADD CONSTRAINT "free_previews_claimed_workspace_id_workspaces_id_fk" FOREIGN KEY ("claimed_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "free_previews_created_at_idx" ON "free_previews" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "free_previews_expires_at_idx" ON "free_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "free_previews_claimed_workspace_id_idx" ON "free_previews" USING btree ("claimed_workspace_id");--> statement-breakpoint

-- >>> Phase 18 hand written: free_previews
-- free_previews (docs/phases/PHASE_18.md P18-12): the free white main image
-- a visitor makes before signup. A platform table like leads (0016) and
-- site_visits (0027): no workspace until a new account claims a row, so RLS
-- is on with no policies, and anon and authenticated lose every privilege,
-- so only the owner connection (the web app) and the service role read or
-- write it. No raw IP or email is stored: ip_hash is a 32 hex digest under a
-- salt that changes every UTC day and lives only in the server process, and
-- email_key a sha256 hex digest.
ALTER TABLE "free_previews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['free_previews'] LOOP
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
      EXECUTE format('REVOKE ALL ON TABLE public.free_previews FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
-- <<< Phase 18 hand written: free_previews
