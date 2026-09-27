-- Custom migration: row level security for every tenant table plus credit ledger functions.
-- This migration never creates the auth schema or auth.uid(); Supabase provides them in
-- production and the test harness creates a shim before applying migrations.
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "brand_kits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "source_media" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "generation_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "asset_variants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credit_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "referrals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "share_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gallery_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "churn_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- workspaces: a user sees only workspaces they belong to. Workspace creation is done
-- by the service role, so the with check clause intentionally blocks client inserts.
CREATE POLICY "workspaces_tenant_isolation" ON "workspaces"
  FOR ALL
  USING (id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

-- members: a user sees their own membership rows. A self referencing subquery here
-- would recurse, and membership writes belong to the service role only.
CREATE POLICY "members_select_own" ON "members"
  FOR SELECT
  USING (user_id = auth.uid());
--> statement-breakpoint

CREATE POLICY "brand_kits_tenant_isolation" ON "brand_kits"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "products_tenant_isolation" ON "products"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "source_media_tenant_isolation" ON "source_media"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

-- generation_jobs: every member can read, but only owner, admin and editor can create
-- or update jobs. The client role reviews assets and never generates or bills.
CREATE POLICY "generation_jobs_select" ON "generation_jobs"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "generation_jobs_insert_non_client" ON "generation_jobs"
  FOR INSERT
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));
--> statement-breakpoint

CREATE POLICY "generation_jobs_update_non_client" ON "generation_jobs"
  FOR UPDATE
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));
--> statement-breakpoint

CREATE POLICY "job_steps_tenant_isolation" ON "job_steps"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "assets_tenant_isolation" ON "assets"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "asset_variants_tenant_isolation" ON "asset_variants"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

-- credit_ledger: every member can read, only owner, admin and editor can insert,
-- and nobody updates or deletes ledger rows from the client side. Billing writes
-- normally come from the service role or the ledger functions below.
CREATE POLICY "credit_ledger_select" ON "credit_ledger"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "credit_ledger_insert_non_client" ON "credit_ledger"
  FOR INSERT
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));
--> statement-breakpoint

CREATE POLICY "subscriptions_tenant_isolation" ON "subscriptions"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "referrals_tenant_isolation" ON "referrals"
  FOR ALL
  USING (referrer_workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (referrer_workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "share_links_tenant_isolation" ON "share_links"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

-- Anyone can read a share link that was made public.
CREATE POLICY "share_links_public_read" ON "share_links"
  FOR SELECT
  USING ("public" = true);
--> statement-breakpoint

CREATE POLICY "gallery_items_tenant_isolation" ON "gallery_items"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

-- The public gallery only ever contains consented items, so reads are open.
CREATE POLICY "gallery_items_public_read" ON "gallery_items"
  FOR SELECT
  USING (true);
--> statement-breakpoint

CREATE POLICY "integrations_tenant_isolation" ON "integrations"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "events_tenant_isolation" ON "events"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

CREATE POLICY "churn_scores_tenant_isolation" ON "churn_scores"
  FOR ALL
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid()));
--> statement-breakpoint

-- Credit balance is the sum of ledger deltas for a workspace.
CREATE OR REPLACE FUNCTION credit_balance(ws uuid) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  select coalesce(sum(delta), 0)::integer from credit_ledger where workspace_id = ws;
$$;
--> statement-breakpoint

-- Reserve credits for a job. Locks the workspace row so concurrent reservations
-- serialize, checks the balance, then writes a negative reserve row.
CREATE OR REPLACE FUNCTION reserve_credits(ws uuid, amount integer, job uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bal integer;
BEGIN
  IF amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'reserve amount must be a positive integer, got %', amount;
  END IF;
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace % not found', ws;
  END IF;
  SELECT coalesce(sum(delta), 0)::integer INTO bal FROM credit_ledger WHERE workspace_id = ws;
  IF bal < amount THEN
    RAISE EXCEPTION 'insufficient credit balance for workspace %: have %, need %', ws, bal, amount;
  END IF;
  INSERT INTO credit_ledger (workspace_id, delta, reason, source, job_id)
  VALUES (ws, -amount, 'reserve', 'system', job);
  IF job IS NOT NULL THEN
    UPDATE generation_jobs
    SET credits_reserved = credits_reserved + amount, updated_at = now()
    WHERE id = job;
  END IF;
  RETURN bal - amount;
END;
$fn$;
--> statement-breakpoint

-- Charge part of a job's reservation when an asset passes QC. The reserve row already
-- lowered the balance, so a charge converts held credits by pairing a release row with
-- a charge row. The pair nets to zero and the audit trail stays complete.
CREATE OR REPLACE FUNCTION charge_credits(ws uuid, amount integer, job uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  SELECT coalesce(sum(-delta), 0)::integer INTO held
  FROM credit_ledger
  WHERE workspace_id = ws AND job_id = job AND reason IN ('reserve', 'release');
  IF held < amount THEN
    RAISE EXCEPTION 'charge of % exceeds held credits % for job %', amount, held, job;
  END IF;
  INSERT INTO credit_ledger (workspace_id, delta, reason, source, job_id)
  VALUES (ws, amount, 'release', 'system', job),
         (ws, -amount, 'charge', 'system', job);
  UPDATE generation_jobs
  SET credits_charged = credits_charged + amount, updated_at = now()
  WHERE id = job;
  RETURN held - amount;
END;
$fn$;
--> statement-breakpoint

-- Release whatever is still held for a job, for failures and cancellations.
-- Returns the number of credits released back to the workspace balance.
CREATE OR REPLACE FUNCTION release_credits(ws uuid, job uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  held integer;
BEGIN
  IF job IS NULL THEN
    RAISE EXCEPTION 'release_credits requires a job id';
  END IF;
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace % not found', ws;
  END IF;
  SELECT coalesce(sum(-delta), 0)::integer INTO held
  FROM credit_ledger
  WHERE workspace_id = ws AND job_id = job AND reason IN ('reserve', 'release');
  IF held > 0 THEN
    INSERT INTO credit_ledger (workspace_id, delta, reason, source, job_id)
    VALUES (ws, held, 'release', 'system', job);
  END IF;
  RETURN held;
END;
$fn$;
