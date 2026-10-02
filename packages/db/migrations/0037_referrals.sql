CREATE TABLE "referral_codes" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_check" CHECK ("referral_codes"."code" ~ '^[a-z0-9]{4,32}$')
);
--> statement-breakpoint
DROP INDEX "referrals_referred_workspace_id_idx";--> statement-breakpoint
/* 
    Unfortunately in current drizzle-kit version we can't automatically get name for primary key.
    We are working on making it available!

    Meanwhile you can:
        1. Check pk name in your database, by running
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = 'public'
                AND table_name = 'referrals'
                AND constraint_type = 'PRIMARY KEY';
        2. Uncomment code below and paste pk name manually
        
    Hope to release this update as soon as possible
*/

ALTER TABLE "referrals" DROP CONSTRAINT "referrals_pkey";--> statement-breakpoint
ALTER TABLE "referrals" ALTER COLUMN "code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "qualifying_payment" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "qualified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_uq" ON "referral_codes" USING btree ("code");--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_code_referral_codes_code_fk" FOREIGN KEY ("code") REFERENCES "public"."referral_codes"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referred_workspace_id_uq" ON "referrals" USING btree ("referred_workspace_id");--> statement-breakpoint
CREATE INDEX "referrals_qualifying_payment_idx" ON "referrals" USING btree ("qualifying_payment");--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_status_check" CHECK ("referrals"."status" in ('pending', 'qualified', 'rewarded', 'rejected', 'reversed'));--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_reject_reason_check" CHECK (("referrals"."status" in ('rejected', 'reversed')) = ("referrals"."reject_reason" is not null) and char_length(coalesce("referrals"."reject_reason", '')) <= 40);--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_qualifying_payment_check" CHECK ("referrals"."qualifying_payment" is null or "referrals"."qualifying_payment" ~ '^(invoice|checkout):[A-Za-z0-9_]{1,200}$');--> statement-breakpoint

-- >>> Phase 18 hand written: referrals
--
-- docs/phases/PHASE_18.md P18-24 (Lane 9 Offer).
--
-- INTEGRATORS: drizzle-kit cannot name the old primary key, so a freshly
-- generated copy of this migration carries the DROP CONSTRAINT as a comment
-- ("-- ALTER TABLE "referrals" DROP CONSTRAINT "<constraint_name>";").
-- After regenerating, replace that comment line with
--   ALTER TABLE "referrals" DROP CONSTRAINT "referrals_pkey";--> statement-breakpoint
-- referrals_pkey is the name Postgres gave 0000's primary key on code.
-- Without it the ADD COLUMN "id" ... PRIMARY KEY line fails, and so does
-- every packages/db test at createTestDb.
--
-- Refusal: the rework assumes referrals is empty, which it is wherever no
-- code wrote it (none did before this phase; check with
-- select count(*) from referrals before applying). A row that carries a
-- code already fails at the new code foreign key above; the block below
-- refuses any row left. Either error happens inside the migration's one
-- transaction (drizzle-kit migrate, or the Supabase SQL editor, which runs
-- the pasted script as one), so nothing above is kept.
--
-- referral_codes is a tenant table: members of the workspace read their own
-- code; the server issues it over the owner connection, so there is no
-- write policy and the client roles lose their write grants as a second
-- layer (the 0026 pattern). referrals gets the same revoke, and 0011's
-- referrals_select_member is dropped: the reworked rows hold the referred
-- workspace's id, its Stripe invoice or checkout session id
-- (qualifying_payment) and why it was rejected (email_reused says the
-- invitee's address already had a Curvi account), which are another
-- tenant's facts. No client reads referrals: /app/settings/referrals shows
-- the referrer only counts, read over the owner connection
-- (apps/web/src/lib/referrals/service.ts referralSummary).
--
-- credit_ledger_referral_step_uq makes each referral reward and each
-- reversal one ledger row: step_key referral:<referral id>:<side> and
-- referral:<referral id>:<side>:reversed (apps/web/src/lib/referrals).

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.referrals) THEN
    RAISE EXCEPTION 'referrals is not empty; the referrals rework (PHASE_18 P18-24) expects an empty table. Move its rows aside first.';
  END IF;
END
$do$;--> statement-breakpoint

ALTER TABLE "referral_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['referral_codes'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;--> statement-breakpoint

DROP POLICY IF EXISTS "referrals_select_member" ON "referrals";--> statement-breakpoint

CREATE POLICY "referral_codes_select_member" ON "referral_codes"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.referral_codes FROM %I', r);
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.referrals FROM %I', r);
    END IF;
  END LOOP;
END
$do$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_referral_step_uq"
  ON "credit_ledger" ("step_key")
  WHERE "reason" = 'referral' AND "step_key" IS NOT NULL;
-- <<< Phase 18 hand written: referrals
