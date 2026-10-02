-- PHASE_20 Lane 2 Billing terms (docs/phases/PHASE_20.md P20-05, P20-06
-- and P20-07, "Data model summary"). Expand only: new nullable columns, a
-- NOT NULL dropped, a new table and a data clear of a value nothing reads,
-- so the code before it keeps working and a rollback stays safe.
--
-- P20-05, founder decision 10: credits never expire while the account is
-- open. Top ups used to write credit_ledger.expires_at 12 months out, which
-- nothing ever read; the code no longer writes it, and this clears the old
-- values so no ledger row stores an expiry. The column stays (a later phase
-- may use it for credit lots).
--
-- P20-06 (P0 stopgap): cancel_flows.released_schedule_id records a
-- subscription schedule (a downgrade the founder scheduled by hand) that the
-- cancel flow released before pausing, discounting or canceling.
--
-- P20-07 (P0 part):
-- - billing_consents: one row per accepted plan Checkout, written by the
--   Stripe webhook from the session (the disclosure version and hash from
--   its metadata, the exact text from its custom_text, the buyer's email
--   and customer), and one per plan change a subscriber starts from
--   /app/billing with the renewal terms beside the button (keyed by the
--   portal session). Exactly one of the two session ids is set. Tenant
--   table: owners and admins of the workspace read; no client writes, and
--   anon and authenticated lose their write grants too (TRUNCATE ignores
--   RLS), as 0026 does for api_keys; no_oauth_clients. workspace_id is set
--   null when the workspace is deleted, so the record outlives the account
--   as California asks.
-- - subscriptions.cadence ("monthly" or "annual"), written by the webhook
--   from the price's interval, read by the renewal notices; the table's
--   existing member read policy covers it and clients still cannot write.
-- - cancel_flows.reason may be null: the reason is optional (Minnesota).

CREATE TABLE "billing_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"user_id" uuid,
	"email_key" text,
	"email" text,
	"stripe_customer_id" text,
	"checkout_session_id" text,
	"portal_session_id" text,
	"tier" text NOT NULL,
	"cadence" text NOT NULL,
	"amount_usd" numeric(10, 2),
	"disclosure_version" text NOT NULL,
	"disclosure_sha256" text NOT NULL,
	"disclosure_text" text,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_consents_one_session" CHECK (("billing_consents"."checkout_session_id" IS NULL) <> ("billing_consents"."portal_session_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "cancel_flows" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cancel_flows" ADD COLUMN "released_schedule_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cadence" text;--> statement-breakpoint
ALTER TABLE "billing_consents" ADD CONSTRAINT "billing_consents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_consents_checkout_session_uq" ON "billing_consents" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_consents_portal_session_uq" ON "billing_consents" USING btree ("portal_session_id");--> statement-breakpoint
CREATE INDEX "billing_consents_workspace_id_idx" ON "billing_consents" USING btree ("workspace_id");--> statement-breakpoint

-- >>> Phase 20 hand written: billing_terms

UPDATE "credit_ledger" SET "expires_at" = NULL
WHERE "reason" = 'topup' AND "expires_at" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "billing_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "billing_consents_select_owner_admin" ON "billing_consents"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')));--> statement-breakpoint

-- no_oauth_clients (0028_mcp_connections, PHASE_19): the restrictive policy
-- every public table carries, so a token from Supabase's OAuth server (its
-- claims carry client_id) reaches nothing here through the Data API. Same
-- definition as 0028.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['billing_consents'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;--> statement-breakpoint

-- No client role writes the consent record; RLS already refuses insert,
-- update and delete, and TRUNCATE ignores RLS, so the grants go too.
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.billing_consents FROM %I', r);
    END IF;
  END LOOP;
END
$do$;--> statement-breakpoint

-- <<< Phase 20 hand written: billing_terms
