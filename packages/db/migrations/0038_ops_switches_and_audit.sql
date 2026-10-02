-- PHASE_20 Lane 5 Operator basics (docs/phases/PHASE_20.md, P20-20 and
-- P20-66, "Data model summary"). Expand only: nothing here deletes, renames
-- or rewrites a row or a column, so the code before it keeps working and a
-- rollback stays safe.
--
-- Operator switches (P20-20): values the founder sets at runtime move to
--   platform_settings keys under "ops:", which pnpm db:seed never writes
--   (the loader refuses one), so a release's re-seed can no longer reset a
--   switch the founder flipped. This migration copies each existing switch
--   row to its ops: key once, ON CONFLICT DO NOTHING, and leaves the old
--   key in place for the running code and any rollback. A missing old row
--   copies nothing, and the new reader (opsSwitch, apps/web/src/lib/
--   features.ts) then falls back to the seed's opsSwitchDefaults. The old
--   keys go in a later migration, ops_switches_contract (Release 3, Lane 5b),
--   once every reader has used opsSwitch in production for one release.
--   Copied as stored, whatever the JSON type, so a value today's reader
--   treats as off is still read as off. The list holds main's
--   output_options_enabled and the PHASE_18 switches the founder flips by
--   SQL (acquisition_paused, free_preview_enabled, lifecycle_email_enabled,
--   referrals_enabled, deploy_restarts_enabled, founding_offer_enabled);
--   where PHASE_18 has not run yet there is no row and nothing is copied.
--   store_audit_enabled stays a seeded release gate and is not copied.
--
-- ops_audit (P20-66, principle 9): the operator audit trail. One row per
--   operator mutation, written in the same transaction as the change by
--   writeOpsAudit (apps/web/src/lib/ops/audit.ts). workspace_id has no
--   foreign key, so deleting a workspace never deletes its trail. Platform
--   table: RLS on with no policies, every privilege revoked from anon and
--   authenticated on the table and its id sequence (the 0010 and 0027
--   pattern), and 0028_mcp_connections' restrictive no_oauth_clients
--   policy, which packages/db/src/mcp-connections.test.ts checks on every
--   public table.
CREATE TABLE "ops_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_email" text NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text,
	"workspace_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"forced" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ops_audit_lengths_check" CHECK (char_length("ops_audit"."operator_email") between 3 and 320 and char_length("ops_audit"."action") between 1 and 64 and char_length("ops_audit"."target_kind") between 1 and 64 and char_length(coalesce("ops_audit"."target_id", '')) <= 200)
);
--> statement-breakpoint
CREATE INDEX "ops_audit_at_idx" ON "ops_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "ops_audit_workspace_id_idx" ON "ops_audit" USING btree ("workspace_id");--> statement-breakpoint

-- >>> Phase 20 hand written: ops_switches_and_audit

INSERT INTO "platform_settings" ("key", "value", "updated_at")
SELECT 'ops:' || "key", "value", now()
FROM "platform_settings"
WHERE "key" IN (
  'output_options_enabled',
  'acquisition_paused',
  'free_preview_enabled',
  'lifecycle_email_enabled',
  'referrals_enabled',
  'deploy_restarts_enabled',
  'founding_offer_enabled'
)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

ALTER TABLE "ops_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.ops_audit FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.ops_audit_id_seq FROM %I', r);
    END IF;
  END LOOP;
END
$do$;--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['ops_audit'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;

-- <<< Phase 20 hand written: ops_switches_and_audit
