CREATE TABLE "pack_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"job_id" uuid NOT NULL,
	"staff_workspace_id" uuid NOT NULL,
	"prospect_label" text NOT NULL,
	"product_source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by_workspace_id" uuid,
	"claimed_at" timestamp with time zone,
	"taken_down_at" timestamp with time zone,
	CONSTRAINT "pack_claims_token_hash_check" CHECK ("pack_claims"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pack_claims_lengths_check" CHECK (char_length(btrim("pack_claims"."prospect_label")) between 1 and 80 and char_length(coalesce("pack_claims"."product_source_url", '')) <= 2048),
	CONSTRAINT "pack_claims_claim_check" CHECK ("pack_claims"."claimed_by_workspace_id" is null or "pack_claims"."claimed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "pack_claims" ADD CONSTRAINT "pack_claims_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_claims" ADD CONSTRAINT "pack_claims_staff_workspace_id_workspaces_id_fk" FOREIGN KEY ("staff_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_claims" ADD CONSTRAINT "pack_claims_claimed_by_workspace_id_workspaces_id_fk" FOREIGN KEY ("claimed_by_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_claims_token_hash_uq" ON "pack_claims" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_claims_job_id_uq" ON "pack_claims" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "pack_claims_staff_workspace_id_idx" ON "pack_claims" USING btree ("staff_workspace_id");--> statement-breakpoint
CREATE INDEX "pack_claims_claimed_by_workspace_id_idx" ON "pack_claims" USING btree ("claimed_by_workspace_id");--> statement-breakpoint

-- >>> Phase 18 hand written: pack_claims
-- pack_claims (docs/phases/PHASE_18.md P18-04): the operator's prospect
-- packs and their claim links. A platform table like leads (0016) and
-- free_previews: the server checks the operator allowlist (OPS_EMAILS) and
-- reads and writes over the owner connection, so RLS is on with no
-- policies, and anon and authenticated lose every privilege. Only the
-- sha256 of a claim token is stored.
ALTER TABLE "pack_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['pack_claims'] LOOP
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
      EXECUTE format('REVOKE ALL ON TABLE public.pack_claims FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
-- <<< Phase 18 hand written: pack_claims
