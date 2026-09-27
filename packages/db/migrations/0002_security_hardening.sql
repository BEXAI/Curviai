ALTER TABLE "credit_ledger" ADD COLUMN "step_key" text;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_job_step_charge_uq" ON "credit_ledger" USING btree ("job_id","step_key") WHERE reason = 'charge' and step_key is not null;--> statement-breakpoint

-- Security hardening. Fixes verified findings from the RLS audit of 0001.
-- 0001 already shipped, so every change lands here instead of rewriting history.

-- Finding 1: members with role owner/admin/editor could insert arbitrary ledger rows
-- (delta 1000000, reason grant, source stripe) and self-grant unlimited credits.
-- Ledger writes only ever come from the service role or the SECURITY DEFINER
-- functions below, so the client-facing INSERT policy is dropped entirely.
-- Members keep SELECT through credit_ledger_select.
DROP POLICY "credit_ledger_insert_non_client" ON "credit_ledger";--> statement-breakpoint

-- Finding 3: workspaces had a single FOR ALL membership policy, so a client-role
-- member could UPDATE plan (entitlement escalation) or DELETE the workspace
-- (cascade wipe of every tenant table). Split into SELECT for every member and
-- UPDATE for owner/admin only, with no DELETE or INSERT policy for clients at all.
DROP POLICY "workspaces_tenant_isolation" ON "workspaces";--> statement-breakpoint

CREATE POLICY "workspaces_select_member" ON "workspaces"
  FOR SELECT
  USING (id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

CREATE POLICY "workspaces_update_owner_admin" ON "workspaces"
  FOR UPDATE
  USING (id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')))
  WITH CHECK (id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')));--> statement-breakpoint

-- Finding 3, column protection: plan, stripe_customer_id and shopify_shop are
-- billing-owned and must never change through a client connection, even for the
-- workspace owner. A trigger is used instead of column-level REVOKEs because
-- column grants depend on role setup that differs between Supabase and the PGlite
-- harness, while a trigger enforces the rule identically in both. Service-level
-- connections (superuser, BYPASSRLS roles such as Supabase's service_role) pass.
CREATE FUNCTION enforce_workspace_protected_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
     OR NEW.shopify_shop IS DISTINCT FROM OLD.shopify_shop THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolname = 'service_role')
    ) THEN
      RAISE EXCEPTION 'workspaces.plan, stripe_customer_id and shopify_shop can only be changed by the service role';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER workspaces_protect_billing_columns
BEFORE UPDATE ON "workspaces"
FOR EACH ROW
EXECUTE FUNCTION enforce_workspace_protected_columns();--> statement-breakpoint

-- Finding 4: subscriptions had FOR ALL on membership, so any member could insert
-- tier agency status active without paying. Members read; only the service role
-- (which bypasses RLS) writes subscription rows from billing webhooks.
DROP POLICY "subscriptions_tenant_isolation" ON "subscriptions";--> statement-breakpoint

CREATE POLICY "subscriptions_select_member" ON "subscriptions"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

-- Finding 5: recipes and channel_specs had no RLS, so under Supabase default
-- grants any anon key holder could rewrite system prompts and channel specs.
-- Enable RLS with a read-only policy for authenticated users (auth.uid() is null
-- for anon) and no write policies. The service role bypasses RLS for seeding.
ALTER TABLE "recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_specs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "recipes_read_authenticated" ON "recipes"
  FOR SELECT
  USING (auth.uid() is not null);--> statement-breakpoint

CREATE POLICY "channel_specs_read_authenticated" ON "channel_specs"
  FOR SELECT
  USING (auth.uid() is not null);--> statement-breakpoint

-- Finding 6: job_steps and churn_scores are pipeline-written cost/audit rows, yet
-- FOR ALL membership policies let any member (including client role) corrupt them.
-- Members read; only the service role writes. events keeps member inserts because
-- the app records product analytics from user sessions, but nobody edits history.
DROP POLICY "job_steps_tenant_isolation" ON "job_steps";--> statement-breakpoint

CREATE POLICY "job_steps_select_member" ON "job_steps"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

DROP POLICY "churn_scores_tenant_isolation" ON "churn_scores";--> statement-breakpoint

CREATE POLICY "churn_scores_select_member" ON "churn_scores"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

DROP POLICY "events_tenant_isolation" ON "events";--> statement-breakpoint

CREATE POLICY "events_select_member" ON "events"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

CREATE POLICY "events_insert_member" ON "events"
  FOR INSERT
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

-- Finding 8: gallery_items_public_read used USING (true), exposing workspace_id
-- and share_slug of every consented item to anonymous enumeration. The public
-- policy now requires an explicit published flag (default false) on top of the
-- existing consent, so enumeration returns nothing until a row is deliberately
-- published. Hiding workspace_id from published rows stays the API layer's job.
DROP POLICY "gallery_items_public_read" ON "gallery_items";--> statement-breakpoint

CREATE POLICY "gallery_items_public_read" ON "gallery_items"
  FOR SELECT
  USING (published = true and consent_at is not null);--> statement-breakpoint

-- Finding 7: charge_credits had no per-asset idempotency, so a retried charge for
-- the same asset double-charged while held credits remained. The function gains an
-- optional step_key parameter stored on the charge ledger row and guarded by the
-- partial unique index credit_ledger_job_step_charge_uq. A repeat charge with the
-- same key is a no-op that returns the unchanged held amount. The old 3-argument
-- call shape keeps working through the DEFAULT NULL, falling back to the previous
-- non-idempotent behavior. Risk: callers that stay on the 3-argument shape remain
-- double-chargeable on retry until they pass a step key.
DROP FUNCTION charge_credits(uuid, integer, uuid);--> statement-breakpoint

CREATE FUNCTION charge_credits(ws uuid, amount integer, job uuid, step_key text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_variable
DECLARE
  held integer;
BEGIN
  IF amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'charge amount must be a positive integer, got %', amount;
  END IF;
  IF job IS NULL THEN
    RAISE EXCEPTION 'charge_credits requires a job id';
  END IF;
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace % not found', ws;
  END IF;
  SELECT coalesce(sum(-cl.delta), 0)::integer INTO held
  FROM credit_ledger cl
  WHERE cl.workspace_id = ws AND cl.job_id = job AND cl.reason IN ('reserve', 'release');
  -- Idempotency: the workspace row lock above serializes concurrent charges, so a
  -- plain existence check is race-free here; the partial unique index still backs
  -- it up against any direct writes.
  IF step_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM credit_ledger cl
    WHERE cl.job_id = job AND cl.reason = 'charge' AND cl.step_key = step_key
  ) THEN
    RETURN held;
  END IF;
  IF held < amount THEN
    RAISE EXCEPTION 'charge of % exceeds held credits % for job %', amount, held, job;
  END IF;
  INSERT INTO credit_ledger (workspace_id, delta, reason, source, job_id, step_key)
  VALUES (ws, amount, 'release', 'system', job, NULL),
         (ws, -amount, 'charge', 'system', job, step_key);
  UPDATE generation_jobs
  SET credits_charged = credits_charged + amount, updated_at = now()
  WHERE id = job;
  RETURN held - amount;
END;
$fn$;--> statement-breakpoint

-- Finding 2: the SECURITY DEFINER ledger functions were executable by PUBLIC (and
-- on Supabase also directly granted to anon/authenticated via default privileges)
-- and take a workspace uuid, so any anon key holder could read a stranger's
-- balance or drain it with reserve_credits. Execution is stripped from every
-- client-facing role; only the service role may call them. The conditional blocks
-- keep the migration valid both on Supabase and in plain Postgres/PGlite where
-- those roles may not exist.
REVOKE EXECUTE ON FUNCTION credit_balance(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION reserve_credits(uuid, integer, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION charge_credits(uuid, integer, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION release_credits(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION credit_balance(uuid), reserve_credits(uuid, integer, uuid), charge_credits(uuid, integer, uuid, text), release_credits(uuid, uuid) FROM %I',
        r
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION credit_balance(uuid), reserve_credits(uuid, integer, uuid), charge_credits(uuid, integer, uuid, text), release_credits(uuid, uuid) TO service_role;
  END IF;
END
$do$;
